import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER_SUPERVISOR_GRACE_MS,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  supervisedPosixLaunch,
  type ProviderSupervisorOptions
} from './codex-app-server-posix-supervisor'

// The provider leads its own group; its grandchild shares that group and ignores SIGTERM.
const PROVIDER = String.raw`
  const { spawn } = require('node:child_process')
  if (process.env.ORCA_TEST_PROVIDER_IGNORES_SIGTERM) process.on('SIGTERM', () => {})
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 60000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  grandchild.stdout.once('data', () => {
    process.stdout.write(JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }) + '\n')
  })
  setInterval(() => {}, 60000)
`

// Stands in for Orca: launches the supervisor as its own child, then can be killed outright. A
// second child holds the supervisor's stdin open, so only the parent-death watch can notice.
const OWNER = String.raw`
  const { spawn } = require('node:child_process')
  const spec = JSON.parse(Buffer.from(process.env.ORCA_PROVIDER_SUPERVISOR_SPEC, 'base64').toString())
  spec.ownerPid = process.pid
  const supervisor = spawn(process.execPath, ['-e', process.env.ORCA_TEST_SUPERVISOR_SCRIPT], {
    env: { ...process.env, ORCA_PROVIDER_SUPERVISOR_SPEC: Buffer.from(JSON.stringify(spec)).toString('base64') },
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true
  })
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: ['ignore', supervisor.stdin, 'ignore']
  })
  process.stdout.write(JSON.stringify({ supervisor: supervisor.pid, holder: holder.pid }) + '\n')
  supervisor.stdout.pipe(process.stdout)
  setInterval(() => {}, 60000)
`

const recordedPids = new Set<number>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function readPids(child: ChildProcess, keys: readonly string[]): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    const pids: Record<string, number> = {}
    let buffered = ''
    const timeout = setTimeout(() => reject(new Error(`no ${keys.join('/')} pids`)), 10_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line)
        for (const [key, pid] of Object.entries(parsed ?? {})) {
          if (typeof pid === 'number') {
            pids[key] = pid
            recordedPids.add(pid)
          }
        }
      }
      if (keys.every((key) => key in pids)) {
        clearTimeout(timeout)
        resolve(pids)
      }
    })
  })
}

function launchSupervisor(
  options: ProviderSupervisorOptions,
  env: Record<string, string> = {},
  provider: { command: string; args: string[] } = {
    command: process.execPath,
    args: ['-e', PROVIDER]
  }
): { supervisor: ChildProcess; exit: Promise<{ code: number | null; signal: string | null }> } {
  const launch = supervisedPosixLaunch(provider, { ...process.env, ...env }, options)
  const supervisor = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true
  })
  recordedPids.add(supervisor.pid!)
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    supervisor.once('exit', (code, signal) => resolve({ code, signal }))
  )
  return { supervisor, exit }
}

afterEach(() => {
  for (const pid of recordedPids) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  recordedPids.clear()
})

describe.runIf(process.platform !== 'win32')('POSIX provider supervisor processes', () => {
  it('reaps the provider group on SIGTERM and exits only after the group is gone', async () => {
    const { supervisor, exit } = launchSupervisor({ graceMs: 300 })
    const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])

    let groupAliveAtExit: boolean | null = null
    void exit.then(() => {
      groupAliveAtExit = alive(-provider)
    })
    supervisor.kill('SIGTERM')

    await expect(exit).resolves.toEqual({ code: null, signal: 'SIGTERM' })
    expect(groupAliveAtExit).toBe(false)
    expect(alive(provider)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })

  it('escalates a SIGTERM-ignoring provider to SIGKILL after the grace from the spec', async () => {
    const graceMs = 200
    const { supervisor, exit } = launchSupervisor(
      { graceMs },
      { ORCA_TEST_PROVIDER_IGNORES_SIGTERM: '1' }
    )
    const { provider, grandchild } = await readPids(supervisor, ['provider', 'grandchild'])

    const signalledAt = Date.now()
    supervisor.kill('SIGTERM')
    const exited = await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))])

    expect(exited).toEqual({ code: null, signal: 'SIGTERM' })
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(graceMs)
    expect(Date.now() - signalledAt).toBeLessThan(DEFAULT_PROVIDER_SUPERVISOR_GRACE_MS)
    expect(alive(provider)).toBe(false)
    expect(alive(grandchild)).toBe(false)
  })

  it('never spawns the provider when its owner is not its parent at start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-supervisor-owner-'))
    try {
      const marker = join(dir, 'provider-started')
      const { exit } = launchSupervisor(
        { ownerPid: process.pid === 1 ? 2 : 1 },
        {},
        { command: 'touch', args: [marker] }
      )

      await expect(exit).resolves.toEqual({ code: 1, signal: null })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reaps the provider group when its owner dies', async () => {
    const launch = supervisedPosixLaunch(
      { command: process.execPath, args: ['-e', PROVIDER] },
      process.env
    )
    const owner = spawn(process.execPath, ['-e', OWNER], {
      env: { ...launch.env, ORCA_TEST_SUPERVISOR_SCRIPT: POSIX_PROVIDER_SUPERVISOR_SCRIPT },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    recordedPids.add(owner.pid!)
    const { supervisor, provider, grandchild } = await readPids(owner, [
      'supervisor',
      'holder',
      'provider',
      'grandchild'
    ])

    owner.kill('SIGKILL')

    expect(await waitFor(() => !alive(-provider), 3_000)).toBe(true)
    expect(await waitFor(() => !alive(supervisor), 3_000)).toBe(true)
    expect(alive(grandchild)).toBe(false)
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerLaunch } from './codex-app-server-connection'
import {
  createProviderSpawnSpec,
  POSIX_PROVIDER_SUPERVISOR_SCRIPT,
  PROVIDER_SIGTERM_GRACE_MS,
  PROVIDER_STDIN_END_GRACE_MS,
  PROVIDER_SUPERVISOR_MAX_STOP_MS,
  stopSupervisedProvider,
  supervisedPosixLaunch
} from './codex-app-server-posix-supervisor'

const launch: CodexAppServerLaunch = {
  command: '/opt/codex',
  args: ['app-server', '--flag'],
  cwd: '/work/repo',
  env: { CODEX_HOME: '/tmp/codex' }
}

describe('structured provider supervision', () => {
  it('wraps POSIX launches in a detached supervisor and preserves the launch spec', () => {
    const childEnv = { PATH: '/bin', CODEX_HOME: '/tmp/codex' }
    const spec = supervisedPosixLaunch(launch, childEnv)

    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toEqual([
      '-e',
      POSIX_PROVIDER_SUPERVISOR_SCRIPT,
      '--',
      '/opt/codex',
      'app-server',
      '--flag'
    ])
    expect(spec.env.PATH).toBe('/bin')
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).toEqual(
      expect.objectContaining({
        cwd: '/work/repo',
        ownerPid: process.pid,
        lifetime: 'session',
        stdinEndGraceMs: PROVIDER_STDIN_END_GRACE_MS,
        sigtermGraceMs: PROVIDER_SIGTERM_GRACE_MS
      })
    )
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).not.toHaveProperty('env')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      'delete childEnv.ORCA_PROVIDER_SUPERVISOR_SPEC'
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain('delete childEnv.ELECTRON_RUN_AS_NODE')
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).toContain(
      "process.stdin.once('close', scheduleOwnerShutdown)"
    )
    expect(POSIX_PROVIDER_SUPERVISOR_SCRIPT).not.toContain('process.ppid === 1')
  })

  it('carries a one-shot lifetime through the spawn spec', () => {
    const spec = createProviderSpawnSpec(launch, { PATH: '/bin' }, 'darwin', {
      lifetime: 'one-shot'
    })

    expect(spec).toMatchObject({ program: process.execPath, detached: true, supervised: true })
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
    ).toMatchObject({ lifetime: 'one-shot' })
  })

  it('keeps the user Node options out of the supervisor env and in the provider spec', () => {
    const spec = supervisedPosixLaunch(launch, {
      PATH: '/bin',
      NODE_OPTIONS: '--require /missing.js',
      NODE_REPL_EXTERNAL_MODULE: '/repl.js'
    })

    expect(spec.env).not.toHaveProperty('NODE_OPTIONS')
    expect(spec.env).not.toHaveProperty('NODE_REPL_EXTERNAL_MODULE')
    expect(
      JSON.parse(Buffer.from(spec.env.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString()).nodeEnv
    ).toEqual({ NODE_OPTIONS: '--require /missing.js', NODE_REPL_EXTERNAL_MODULE: '/repl.js' })
  })

  it('keeps every argv and env string of a 120 KiB argv prompt under the Linux 128 KiB cap', () => {
    const prompt = 'x'.repeat(120 * 1024)
    const spec = createProviderSpawnSpec(
      { command: '/opt/agent', args: ['--print', prompt] },
      { PATH: '/bin' },
      'linux',
      { lifetime: 'one-shot' }
    )
    const strings = [
      ...spec.args,
      ...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`)
    ]

    expect(spec.args.slice(-2)).toEqual(['--print', prompt])
    for (const value of strings) {
      expect(Buffer.byteLength(value)).toBeLessThan(128 * 1024)
    }
  })

  it.each([
    [true, PROVIDER_SUPERVISOR_MAX_STOP_MS + 500],
    [false, 1_500]
  ])('forces a provider (supervised %s) only after %s ms', async (supervised, waitMs) => {
    vi.useFakeTimers()
    try {
      const request = vi.fn()
      const force = vi.fn(async () => {})
      const stopped = stopSupervisedProvider({
        request,
        exitPromise: new Promise(() => {}),
        exited: () => false,
        force,
        supervised,
        directWaitMs: 1_500,
        slackMs: 500
      })
      expect(request).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(waitMs - 1)
      expect(force).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await expect(stopped).resolves.toBe(true)
      expect(force).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never forces a provider that exits within its wait', async () => {
    let exited = false
    let markExited!: () => void
    const force = vi.fn(async () => {})
    const stopped = stopSupervisedProvider({
      request: () => setTimeout(() => ((exited = true), markExited()), 10),
      exitPromise: new Promise((resolve) => (markExited = resolve)),
      exited: () => exited,
      force,
      supervised: true
    })

    await expect(stopped).resolves.toBe(false)
    expect(force).not.toHaveBeenCalled()
  })

  it('refuses a grace longer than recovery waits before SIGKILL', () => {
    const stdinEnd = (stdinEndGraceMs: number) => () =>
      supervisedPosixLaunch(launch, {}, { stdinEndGraceMs })
    const sigterm = (sigtermGraceMs: number) => () =>
      supervisedPosixLaunch(launch, {}, { sigtermGraceMs })

    expect(stdinEnd(PROVIDER_STDIN_END_GRACE_MS)).not.toThrow()
    expect(stdinEnd(PROVIDER_STDIN_END_GRACE_MS + 1)).toThrow(RangeError)
    expect(sigterm(PROVIDER_SIGTERM_GRACE_MS)).not.toThrow()
    expect(sigterm(PROVIDER_SIGTERM_GRACE_MS + 1)).toThrow(RangeError)
  })

  it('uses direct provider spawning on Windows because the job owns the tree', () => {
    expect(createProviderSpawnSpec(launch, { PATH: '/bin' }, 'win32')).toEqual({
      program: '/opt/codex',
      args: ['app-server', '--flag'],
      env: { PATH: '/bin' },
      cwd: '/work/repo',
      detached: false,
      supervised: false
    })
  })
})

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../codex/codex-app-server-posix-supervisor'
import { cancelGenerateCommitMessageLocal } from './commit-message-text-generation'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { killSourceControlAgentProcess } from './source-control-local-process'
import { generateCommitMessage } from './source-control-text-generation-requests'
import type { SpawnedSourceControlAgentProcess } from './source-control-text-generation-types'

const { terminateTreeMock } = vi.hoisted(() => ({
  terminateTreeMock: vi.fn(async () => true)
}))

vi.mock('../codex/codex-app-server-process-teardown', () => ({
  terminateCodexAppServerProcessTree: terminateTreeMock
}))

type FakeSupervisor = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  supervised: true
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
}

function fakeSupervisor(exitsOn: NodeJS.Signals | null): FakeSupervisor {
  const child: FakeSupervisor = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    supervised: true as const,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      if (signal === exitsOn) {
        child.signalCode = signal
        child.emit('exit', null, signal)
      }
      return true
    })
  })
  return child
}

function asSpawned(child: FakeSupervisor): SpawnedSourceControlAgentProcess {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only pid, exit state, kill and the exit event, which the fake implements.
  return child as unknown as SpawnedSourceControlAgentProcess
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  vi.useRealTimers()
  terminateTreeMock.mockClear()
})

describe('killSourceControlAgentProcess for a supervised agent', () => {
  it('asks the supervisor to stop and leaves its group to it', async () => {
    const child = fakeSupervisor('SIGTERM')

    await killSourceControlAgentProcess(asSpawned(child))

    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(terminateTreeMock).not.toHaveBeenCalled()
  })

  it('tears the tree down only once the supervisor has had its full stop time', async () => {
    vi.useFakeTimers()
    const child = fakeSupervisor(null)

    const stopped = killSourceControlAgentProcess(asSpawned(child))
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(terminateTreeMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await stopped
    expect(terminateTreeMock).toHaveBeenCalledWith(child)
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('signals nothing once the supervisor has exited', async () => {
    const child = fakeSupervisor(null)
    child.exitCode = 0

    await killSourceControlAgentProcess(asSpawned(child))

    expect(child.kill).not.toHaveBeenCalled()
    expect(terminateTreeMock).not.toHaveBeenCalled()
  })
})

describe.runIf(process.platform !== 'win32')(
  'killSourceControlAgentProcess on a real agent',
  () => {
    it('stops an agent that ignores its stdin end through its supervisor', async () => {
      const child = spawnSourceControlAgent({
        binary: process.execPath,
        args: ['-e', 'console.log(process.pid); setInterval(() => {}, 60000)'],
        env: process.env,
        stdinMode: 'ignore',
        useCwdForNative: false
      })
      const agentPid = await new Promise<number>((resolve) =>
        child.stdout.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())))
      )

      try {
        await killSourceControlAgentProcess(child)

        expect(child.signalCode ?? child.exitCode).not.toBeNull()
        expect(() => process.kill(agentPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
        expect(terminateTreeMock).not.toHaveBeenCalled()
      } finally {
        for (const pid of [agentPid, child.pid!]) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already gone, as the test expects.
          }
        }
      }
    })

    it('holds the Codex home until a canceled agent has stopped through its supervisor', async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-supervised-cancel-'))
      const pids: number[] = []
      try {
        const home = join(folder, 'codex-home')
        for (const repo of ['first', 'second']) {
          mkdirSync(join(folder, repo))
        }
        const pidFile = join(folder, 'first-pid')
        const stoppedFile = join(folder, 'first-stopped')
        // Ignores its stdin end, then takes a moment to stop on SIGTERM, as a CLI flushing state does.
        const slowStop = join(folder, 'slow-stop.cjs')
        writeFileSync(
          slowStop,
          `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
process.stdin.resume()
process.on('SIGTERM', () => setTimeout(() => {
  require('node:fs').writeFileSync(${JSON.stringify(stoppedFile)}, 'stopped')
  process.exit(0)
}, 300))
setInterval(() => {}, 60000)
`
        )
        const answers = join(folder, 'answers.cjs')
        writeFileSync(
          answers,
          "process.stdin.resume().on('end', () => console.log('Update README'))\n"
        )
        const firstAliveAtSecondSpawn: boolean[] = []
        const spawnAgent = vi.fn((input: Parameters<typeof spawnSourceControlAgent>[0]) => {
          if (pids.length > 0) {
            firstAliveAtSecondSpawn.push(isAlive(pids[0]!))
          }
          return spawnSourceControlAgent(input)
        })
        const request = (cwd: string, script: string): ReturnType<typeof generateCommitMessage> =>
          generateCommitMessage({
            context: { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
            params: {
              agentId: 'codex',
              model: 'gpt-5.5',
              agentCommandOverride: `CODEX_HOME="${home}" "${process.execPath}" "${script}"`
            },
            target: { kind: 'local', cwd, env: process.env },
            spawnAgent
          })

        const first = request(join(folder, 'first'), slowStop)
        await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 })
        pids.push(Number(readFileSync(pidFile, 'utf8')))
        cancelGenerateCommitMessageLocal(join(folder, 'first'))
        await expect(first).resolves.toMatchObject({ canceled: true })

        await expect(request(join(folder, 'second'), answers)).resolves.toMatchObject({
          success: true,
          message: 'Update README'
        })
        expect(firstAliveAtSecondSpawn).toEqual([false])
        expect(readFileSync(stoppedFile, 'utf8')).toBe('stopped')
        expect(terminateTreeMock).not.toHaveBeenCalled()
      } finally {
        for (const pid of pids) {
          if (isAlive(pid)) {
            process.kill(pid, 'SIGKILL')
          }
        }
        rmSync(folder, { recursive: true, force: true })
      }
    })
  }
)

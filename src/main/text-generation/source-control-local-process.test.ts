import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../codex/codex-app-server-posix-supervisor'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { killSourceControlAgentProcess } from './source-control-local-process'
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
  }
)

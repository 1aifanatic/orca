import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcessHandle } from '../../shared/child-process/process-spec'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from './codex-app-server-posix-supervisor'
import { terminateCodexAppServerProcessTree } from './codex-app-server-process-teardown'
import { stopCodexBackfillRecoveryProcess } from './codex-state-db-backfill-recovery-process'

vi.mock('./codex-app-server-process-teardown', () => ({
  terminateCodexAppServerProcessTree: vi.fn(async () => true)
}))

type FakeSupervisor = EventEmitter & {
  pid: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdin: { end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>
}

function fakeSupervisor(exitsOnStdinEnd: boolean): FakeSupervisor {
  const child: FakeSupervisor = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    stdin: {
      end: vi.fn(() => {
        if (exitsOnStdinEnd) {
          child.exitCode = 0
          child.emit('exit', 0, null)
        }
      })
    },
    kill: vi.fn(() => true)
  })
  return child
}

function asHandle(child: FakeSupervisor): ChildProcessHandle {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only pid, exit state, stdin, kill and the exit event, which the fake implements.
  return child as unknown as ChildProcessHandle
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('stopCodexBackfillRecoveryProcess for a supervised app-server', () => {
  it('ends its input and leaves the group stop to the supervisor', async () => {
    const child = fakeSupervisor(true)

    await stopCodexBackfillRecoveryProcess(asHandle(child), true)

    expect(child.stdin.end).toHaveBeenCalledOnce()
    // A direct SIGTERM would skip the stdin-end grace a Codex close gets.
    expect(child.kill).not.toHaveBeenCalled()
    expect(terminateCodexAppServerProcessTree).not.toHaveBeenCalled()
  })

  it('tears the tree down only once the supervisor has had its full stop time', async () => {
    vi.useFakeTimers()
    const child = fakeSupervisor(false)

    const stopped = stopCodexBackfillRecoveryProcess(asHandle(child), true)
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(terminateCodexAppServerProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await stopped

    expect(terminateCodexAppServerProcessTree).toHaveBeenCalledWith(child)
    // Its own SIGKILL would kill the supervisor mid-ladder and orphan the app-server's group.
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')
  })
})

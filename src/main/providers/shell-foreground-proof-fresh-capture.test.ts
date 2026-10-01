import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { createProcessTableSnapshotReader } from '../../shared/process-table-snapshot-reader'
import { CommandEndAgentExitVerifier } from '../runtime/command-end-agent-exit-verifier'
import { resolveRemoteForegroundEvidence } from './agent-foreground-process-batch'
import { proveDaemonShellForeground } from './shell-foreground-proof'

// The daemon's evidence comes from a shared process-table capture whose age runs from the start of
// a `ps` that takes time. A capture the check itself triggers after the command end must prove the
// exit on the first ask; one already cached from before the exit must not.

const SHELL_PID = 100
const PS_MS = 60

const shellOnly: ProcessTableRow[] = [
  {
    pid: SHELL_PID,
    ppid: 1,
    pgid: SHELL_PID,
    tpgid: SHELL_PID,
    tty: '/dev/pts/3',
    startTime: 'shell-birth',
    stat: 'Ss+',
    command: '/bin/zsh'
  }
]

function daemonPane() {
  const ps = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, PS_MS))
    return shellOnly
  })
  const reader = createProcessTableSnapshotReader<ProcessTableRow[]>({ runPs: ps, now: Date.now })
  const reconcileEndedProcess = vi.fn()
  const verifier = new CommandEndAgentExitVerifier({
    readLiveRowAnchors: () =>
      new Map([['tab:pane', { receivedAt: 1, agentType: 'codex', providerSessionId: 's' }]]),
    checkHookAgentPresence: async () => null,
    proveShellForeground: (_ptyId, notCapturedBefore) =>
      proveDaemonShellForeground({
        ptyId: 'pty-1',
        incarnationId: 'inc-1',
        notCapturedBefore,
        platform: 'linux',
        // The daemon's own confirm only proves a shell after a full-screen exit.
        confirmShellForeground: async () => false,
        inspectProcess: async () => {
          const { value, capturedAgeMs } = await reader.getSnapshotWithAge()
          return {
            foregroundProcess: null,
            hasChildProcesses: false,
            foregroundProcessEvidence: resolveRemoteForegroundEvidence(
              { rootPid: SHELL_PID, fallbackProcess: 'zsh' },
              {
                ptyId: 'pty-1',
                ptyIncarnationId: 'inc-1',
                authorityGeneration: 'daemon',
                observationEpoch: ps.mock.calls.length,
                capturedAgeMs,
                platform: 'linux'
              },
              value
            )
          }
        }
      }),
    reconcileEndedProcess,
    now: () => performance.now()
  })
  return { ps, reader, verifier, reconcileEndedProcess }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('a daemon exit proof from the shared process-table capture', () => {
  it('clears on the first ask when the check triggers the capture', async () => {
    const { ps, verifier, reconcileEndedProcess } = daemonPane()

    verifier.onCommandEnd('pty-1')

    await vi.waitFor(() => expect(reconcileEndedProcess).toHaveBeenCalledTimes(1), {
      timeout: 400,
      interval: 10
    })
    expect(ps).toHaveBeenCalledTimes(1)
  })

  it('asks again when the capture it is served began before the command end', async () => {
    const { ps, reader, verifier, reconcileEndedProcess } = daemonPane()
    const pollerCapture = reader.getSnapshotWithAge()

    // The command end lands while another pane's poll is mid-`ps`.
    await new Promise((resolve) => setTimeout(resolve, PS_MS / 2))
    verifier.onCommandEnd('pty-1')
    await pollerCapture
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reconcileEndedProcess).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(reconcileEndedProcess).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
      interval: 20
    })
    expect(ps).toHaveBeenCalledTimes(2)
  })
})

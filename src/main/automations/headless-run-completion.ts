/**
 * When a headlessly dispatched run is complete. A ready shell prompt satisfies `tui-idle` too,
 * so a prompt typed at a shell whose agent is not installed ("command not found") would read as
 * a finished run. Like the desktop runner, completion needs the agent's own status for the run's
 * pane, reported after dispatch; without it the run is never `completed`.
 */
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'

/** Covers agent spin-up over SSH; past it, a pane with no agent status ran no agent. */
export const HEADLESS_AGENT_START_DEADLINE_MS = 2 * 60 * 1000
const AGENT_START_POLL_MS = 1_000
const TERMINAL_SNAPSHOT_LIMIT = 2_000

export type HeadlessRunCompletionHost = {
  waitForTerminal(
    handle: string,
    options?: { condition?: 'tui-idle' }
  ): Promise<{ satisfied: boolean; blockedReason?: string }>
  readTerminal(handle: string, opts?: { limit?: number }): Promise<{ tail: string[] }>
  /** Agent status rows for a pane, from hooks, OSC and titles alike. */
  getAgentStatusRowsForPane(paneKey: string): readonly { receivedAt: number }[]
}

export async function observeHeadlessRunCompletion(
  host: HeadlessRunCompletionHost,
  run: { handle: string; paneKey: string | null; dispatchedAt: number },
  clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
): Promise<AutomationRunCompletionObservation> {
  const agentReported = (): boolean =>
    run.paneKey !== null &&
    host.getAgentStatusRowsForPane(run.paneKey).some((row) => row.receivedAt >= run.dispatchedAt)
  for (;;) {
    const wait = await host.waitForTerminal(run.handle, { condition: 'tui-idle' })
    if (!wait.satisfied) {
      return {
        status: 'dispatch_failed',
        outputSnapshot: await readSnapshot(host, run.handle),
        error: wait.blockedReason
          ? `Automation agent is blocked: ${wait.blockedReason}.`
          : 'Automation agent did not report completion.'
      }
    }
    if (agentReported()) {
      return {
        status: 'completed',
        outputSnapshot: await readSnapshot(host, run.handle),
        error: null
      }
    }
    if (clock.now() - run.dispatchedAt >= HEADLESS_AGENT_START_DEADLINE_MS) {
      return {
        status: 'dispatch_failed',
        outputSnapshot: await readSnapshot(host, run.handle),
        error:
          'Automation agent never reported starting; check that its command is installed on this host.'
      }
    }
    // An idle shell, not an agent: wait for the agent to report before trusting idleness.
    await clock.sleep(AGENT_START_POLL_MS)
  }
}

async function readSnapshot(
  host: HeadlessRunCompletionHost,
  handle: string
): Promise<AutomationRunCompletionObservation['outputSnapshot']> {
  const buffer = createHeadlessAutomationOutputSnapshotBuffer()
  try {
    buffer.append(
      (await host.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })).tail.join('\n')
    )
  } catch {
    // The terminal can exit between the wait and the read; a missing tail is not a failure.
  }
  return buffer.snapshot()
}

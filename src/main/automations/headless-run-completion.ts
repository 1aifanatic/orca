/**
 * When a headlessly dispatched run is complete. A ready shell prompt satisfies `tui-idle` too,
 * so a prompt typed at a shell whose agent is not installed ("command not found") read as a
 * finished run. The agent's own status for the run's pane, reported after dispatch, completes it
 * as on the desktop. Not every agent reports status (no hooks on the host, no recognised title),
 * so for those an idle pane still means done, but only once the agent had time to start and the
 * pane shows no shell refusing its command.
 */
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import { createHeadlessAutomationOutputSnapshotBuffer } from './headless-dispatch'

/** Covers agent spin-up over SSH before an idle pane without agent status is believed. */
export const HEADLESS_AGENT_START_GRACE_MS = 2 * 60 * 1000
const AGENT_START_POLL_MS = 1_000
const TERMINAL_SNAPSHOT_LIMIT = 2_000
/** Only output after the prompt: a refusal further up predates this dispatch. */
const MISSING_COMMAND_TAIL_LINES = 6

// bash, zsh, dash/sh, fish, PowerShell and cmd.exe refusing a command that does not exist.
const MISSING_COMMAND_PATTERNS = [
  /command not found/i,
  /^\S+: \d+: \S+: not found$/i,
  /unknown command/i,
  /is not recognized as (?:the name of a cmdlet|an internal or external command)/i
]

/** A shell refusing one of the agent's own commands; an agent's tool output never matches. */
export function findMissingCommandLine(
  tail: readonly string[],
  commands: readonly string[]
): string | null {
  const names = commands.map((command) => command.split(/\s+/)[0]).filter(Boolean)
  const recent = tail
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MISSING_COMMAND_TAIL_LINES)
  return (
    recent.find(
      (line) =>
        MISSING_COMMAND_PATTERNS.some((pattern) => pattern.test(line)) &&
        names.some((name) => line.includes(name))
    ) ?? null
  )
}

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
  run: {
    handle: string
    paneKey: string | null
    dispatchedAt: number
    /** The names the agent's command may run under, to tell its refusal from its output. */
    agentCommands: readonly string[]
  },
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
    const tail = await readTail(host, run.handle)
    const outputSnapshot = snapshotOf(tail)
    if (!wait.satisfied) {
      return {
        status: 'dispatch_failed',
        outputSnapshot,
        error: wait.blockedReason
          ? `Automation agent is blocked: ${wait.blockedReason}.`
          : 'Automation agent did not report completion.'
      }
    }
    if (agentReported()) {
      return { status: 'completed', outputSnapshot, error: null }
    }
    const missing = findMissingCommandLine(tail, run.agentCommands)
    if (missing) {
      return {
        status: 'dispatch_failed',
        outputSnapshot,
        error: `Automation agent did not start; this host could not run its command (${missing}).`
      }
    }
    // An agent that never reports status keeps the idle-means-done rule, after its start window.
    if (clock.now() - run.dispatchedAt >= HEADLESS_AGENT_START_GRACE_MS) {
      return { status: 'completed', outputSnapshot, error: null }
    }
    await clock.sleep(AGENT_START_POLL_MS)
  }
}

async function readTail(host: HeadlessRunCompletionHost, handle: string): Promise<string[]> {
  try {
    return (await host.readTerminal(handle, { limit: TERMINAL_SNAPSHOT_LIMIT })).tail
  } catch {
    // The terminal can exit between the wait and the read; a missing tail is not a failure.
    return []
  }
}

function snapshotOf(tail: readonly string[]): AutomationRunCompletionObservation['outputSnapshot'] {
  const buffer = createHeadlessAutomationOutputSnapshotBuffer()
  buffer.append(tail.join('\n'))
  return buffer.snapshot()
}

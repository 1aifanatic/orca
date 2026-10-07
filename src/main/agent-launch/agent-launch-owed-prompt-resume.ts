/**
 * Finishes the first prompts a host stopped owing mid-launch, on the rule its record makes exact:
 *
 *   owed, the agent's terminal still there  ->  pasted once, as the launch would have pasted it
 *   owed, the terminal gone                 ->  not-delivered: the agent exited before it was ready
 *   writing                                 ->  unconfirmed: the paste may have landed, so never again
 *
 * The terminal daemon outlives the app, so after a restart the agent the launch started is usually
 * still running and its prompt can still reach it. One resume per launch at a time, and W2's
 * compare-and-set makes any second writer lose before its first byte.
 */

import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  isAgentLaunchResult,
  type AgentLaunchPromptDisposal,
  type AgentLaunchResult
} from '../../shared/agent-launch-intent'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  beginOwedLaunchPromptWrite,
  listOwedLaunchPromptRows,
  recordLaunchOutcome,
  type OwedLaunchPromptWriteStart
} from '../runtime/agent-launch-owed-prompt-record'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'

export type OwedLaunchPromptResumeDeps = {
  store: Pick<
    AgentSessionRecordStore,
    'listOperationRows' | 'transactOperations' | 'recordOperationOutcome'
  >
  /** The pane's terminal as this runtime knows it now, or null when nothing holds it. */
  terminalHandleForPane: (paneKey: string) => string | null
  /** The launch's own guarded paste, with W2 before its first byte. */
  deliver: (args: {
    callerKey: string
    handle: string
    agent: TuiAgent
    text: string
    beginPromptWrite: () => Promise<OwedLaunchPromptWriteStart>
  }) => Promise<boolean>
  /** A launch this process is still running delivers its own prompt. */
  isLaunchRunning: (operationKey: string) => boolean
  now: () => number
}

const resumesInFlight = new Map<string, Promise<void>>()

/** Every row the record says still owes a prompt, each resumed at most once at a time. */
export async function resumeOwedLaunchPrompts(deps: OwedLaunchPromptResumeDeps): Promise<void> {
  const owing = listOwedLaunchPromptRows(deps.store.listOperationRows(), deps.now())
  await Promise.all(owing.map(({ row }) => resumeOwedLaunchPrompt(deps, row)))
}

/** One launch's owed prompt; joins a resume already running for it. */
export function resumeOwedLaunchPrompt(
  deps: OwedLaunchPromptResumeDeps,
  row: AgentSessionOperationRow
): Promise<void> {
  const key = agentSessionOperationKey(row.callerKey, row.operationId)
  if (deps.isLaunchRunning(key)) {
    return Promise.resolve()
  }
  const running = resumesInFlight.get(key)
  if (running) {
    return running
  }
  const resume = settleOwedPrompt(deps, row)
    .catch((error: unknown) => {
      // Bookkeeping: the row stays as it was, and the next start tries again until it expires.
      console.warn('[agent-launch] could not finish an owed launch prompt', error)
    })
    .finally(() => {
      resumesInFlight.delete(key)
    })
  resumesInFlight.set(key, resume)
  return resume
}

async function settleOwedPrompt(
  deps: OwedLaunchPromptResumeDeps,
  row: AgentSessionOperationRow
): Promise<void> {
  const [entry] = listOwedLaunchPromptRows([row], deps.now())
  const succeeded = row.outcome.status === 'succeeded' ? row.outcome : null
  const launch = succeeded?.launch
  if (!entry || !succeeded || !isAgentLaunchResult(launch)) {
    return
  }
  const ref = { callerKey: row.callerKey, operationId: row.operationId }
  const settle = (disposal: AgentLaunchPromptDisposal) =>
    recordLaunchOutcome(deps.store, {
      ...ref,
      outcome: { ...succeeded, launch: withPromptDisposal(launch, disposal) }
    })
  if (entry.owed.state === 'writing') {
    return settle({ outcome: 'unconfirmed' })
  }
  const paneKey = launch.outcome.kind === 'terminal' ? launch.outcome.paneKey : undefined
  const handle = paneKey ? deps.terminalHandleForPane(paneKey) : null
  if (!handle) {
    return settle({ outcome: 'not-delivered' })
  }
  let taken = false
  const delivered = await deps.deliver({
    callerKey: row.callerKey,
    handle,
    agent: entry.owed.agent,
    text: entry.owed.text,
    beginPromptWrite: async () => {
      const start = await beginOwedLaunchPromptWrite(deps.store, ref, deps.now())
      taken = start === 'taken'
      return start
    }
  })
  if (taken) {
    // Another writer began this prompt and settles it.
    return
  }
  return settle({ outcome: delivered ? 'handed-to-terminal' : 'not-delivered' })
}

function withPromptDisposal(
  launch: AgentLaunchResult,
  disposal: AgentLaunchPromptDisposal
): AgentLaunchResult {
  return launch.prompt ? { ...launch, prompt: { ...launch.prompt, ...disposal } } : launch
}

export function resetOwedLaunchPromptResumesForTests(): void {
  resumesInFlight.clear()
}

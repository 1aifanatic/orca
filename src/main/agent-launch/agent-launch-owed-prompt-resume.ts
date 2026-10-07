/**
 * Finishes the first prompts a host stopped owing mid-launch, on the rule its record makes exact:
 *
 *   owed, the agent's terminal still there  ->  pasted once, as the launch would have pasted it
 *   owed, its terminal not found yet        ->  left owed: its provider (an SSH relay) may report later
 *   owed, another PTY holds the pane        ->  not-delivered: the agent is gone, whatever runs there now
 *   owed, past its deadline                 ->  not-delivered: too late to paste into an idle agent
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
  launchPromptMayHaveBeenWritten,
  listOwedLaunchPromptRows,
  resetUnrecordedLaunchPromptWritesForTests,
  recordLaunchOutcome,
  type OwedLaunchPromptWriteStart
} from '../runtime/agent-launch-owed-prompt-record'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'

export type OwedLaunchPromptResumeDeps = {
  store: Pick<
    AgentSessionRecordStore,
    'listOperationRows' | 'transactOperations' | 'recordOperationOutcome'
  >
  /** The pane's terminal as this runtime knows it now, and the PTY it is; null when the runtime
   *  knows nothing there yet. */
  terminalForPane: (
    paneKey: string
  ) => { handle: string; terminal: { ptyId: string; incarnationId: string | null } | null } | null
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

/** `retry`: still owed, and worth another sweep once a terminal provider reports. */
export type OwedLaunchPromptResume = 'settled' | 'retry'

const resumesInFlight = new Map<string, Promise<OwedLaunchPromptResume>>()

/** Every row the record says still owes a prompt, each resumed at most once at a time; whether
 *  any is still owed and waiting on its terminal. */
export async function resumeOwedLaunchPrompts(deps: OwedLaunchPromptResumeDeps): Promise<boolean> {
  const owing = listOwedLaunchPromptRows(deps.store.listOperationRows(), deps.now())
  const results = await Promise.all(owing.map(({ row }) => resumeOwedLaunchPrompt(deps, row)))
  return results.includes('retry')
}

/** One launch's owed prompt; joins a resume already running for it. */
export function resumeOwedLaunchPrompt(
  deps: OwedLaunchPromptResumeDeps,
  row: AgentSessionOperationRow
): Promise<OwedLaunchPromptResume> {
  const key = agentSessionOperationKey(row.callerKey, row.operationId)
  if (deps.isLaunchRunning(key)) {
    return Promise.resolve('settled')
  }
  const running = resumesInFlight.get(key)
  if (running) {
    return running
  }
  const resume = settleOwedPrompt(deps, row)
    .catch((error: unknown): OwedLaunchPromptResume => {
      // Bookkeeping: the row stays as it was. Only a prompt still owed, and inside its deadline, is
      // worth another sweep; one that may have been written never is.
      console.warn('[agent-launch] could not finish an owed launch prompt', error)
      const [entry] = listOwedLaunchPromptRows([row], deps.now())
      return entry?.owed.state === 'owed' && deps.now() <= entry.owed.deadline ? 'retry' : 'settled'
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
): Promise<OwedLaunchPromptResume> {
  const [entry] = listOwedLaunchPromptRows([row], deps.now())
  const succeeded = row.outcome.status === 'succeeded' ? row.outcome : null
  const launch = succeeded?.launch
  if (!entry || !succeeded || !isAgentLaunchResult(launch)) {
    return 'settled'
  }
  const ref = { callerKey: row.callerKey, operationId: row.operationId }
  const settle = async (disposal: AgentLaunchPromptDisposal): Promise<OwedLaunchPromptResume> => {
    await recordLaunchOutcome(deps.store, {
      ...ref,
      outcome: { ...succeeded, launch: withPromptDisposal(launch, disposal) }
    })
    return 'settled'
  }
  // A row still owed after this process wrote it without recording so (its W2 and settle failed)
  // reads like one never written: that write may have landed, so it is never written again.
  if (entry.owed.state === 'writing' || launchPromptMayHaveBeenWritten(ref)) {
    return settle({ outcome: 'unconfirmed' })
  }
  if (deps.now() > entry.owed.deadline) {
    return settle({ outcome: 'not-delivered' })
  }
  const paneKey = launch.outcome.kind === 'terminal' ? launch.outcome.paneKey : undefined
  if (!paneKey) {
    return settle({ outcome: 'not-delivered' })
  }
  const found = deps.terminalForPane(paneKey)
  if (!found?.terminal) {
    // Not found is not gone: its terminal's provider (an SSH relay) may not have reported yet.
    return 'retry'
  }
  if (!samePty(entry.owed.terminal, found.terminal)) {
    // The pane holds another PTY now (the window respawned a shell, say): never paste into it.
    return settle({ outcome: 'not-delivered' })
  }
  const { handle } = found
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
    return 'settled'
  }
  return settle({ outcome: delivered ? 'handed-to-terminal' : 'not-delivered' })
}

/** The launch's own PTY: by incarnation where both know one, else by id. */
function samePty(
  recorded: { ptyId: string; incarnationId: string | null } | null,
  current: { ptyId: string; incarnationId: string | null }
): boolean {
  if (!recorded) {
    return false
  }
  return recorded.incarnationId && current.incarnationId
    ? recorded.incarnationId === current.incarnationId
    : recorded.ptyId === current.ptyId
}

function withPromptDisposal(
  launch: AgentLaunchResult,
  disposal: AgentLaunchPromptDisposal
): AgentLaunchResult {
  return launch.prompt ? { ...launch, prompt: { ...launch.prompt, ...disposal } } : launch
}

export function resetOwedLaunchPromptResumesForTests(): void {
  resumesInFlight.clear()
  resetUnrecordedLaunchPromptWritesForTests()
}

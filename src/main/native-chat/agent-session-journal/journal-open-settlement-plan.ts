// What an open owes a chat whose earlier host process is gone, one rule per kind of entity.
//
// The settlement plan (`structured-agent-session-open-settlement.ts`) and each chat's stored status
// (`journal-session-state.ts`) both read these same rules, so the status shows exactly the work a
// settle would revise. Each rule revises its entity out of the state that selected it, so once the
// plan commits the stored status reads settled.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { cancelledJournalPromptBody } from './journal-prompt-body-bounds'
import type { JournalReducerState } from './journal-reducer'
import { staleSubagentRosterRevision } from './journal-subagent-liveness'

/** The key a settlement revises an item under. One that will not parse cannot be revised, so the
 *  item owes nothing: a fresh identity would duplicate it rather than settle it. */
export function openSettlementItemIdentity(
  item: Pick<AgentJournalRenderItem, 'itemId'>
): AgentJournalItemIdentity | null {
  return parseAgentJournalItemKey(item.itemId)
}

/** A running tool call fails, and a pending approval or question is cancelled. */
export function openSettlementTerminalBody(
  item: Pick<AgentJournalRenderItem, 'body'>
): AgentJournalItemBody | null {
  if (item.body.kind === 'tool-call' && item.body.state === 'running') {
    return { ...item.body, state: 'failed' }
  }
  if (item.body.kind === 'approval' || item.body.kind === 'question') {
    return item.body.resolution.state === 'pending' ? cancelledJournalPromptBody(item.body) : null
  }
  return null
}

/** Every turn record still `running` gets the verdict for its own writer. */
export function isRunningJournalTurn(item: Pick<AgentJournalRenderItem, 'body'>): boolean {
  return readAgentJournalTurn(item.body)?.state === 'running'
}

/** A handed-over send nothing answered: it becomes a recovered `unknown`. A queued one is not. */
export function owesRecoveredDispatch(submission: AgentJournalSubmission): boolean {
  return (
    !isQueuedAgentJournalSubmission(submission) &&
    (submission.dispatchState === 'pending' ||
      (submission.dispatchState === 'unknown' && submission.recovered !== true))
  )
}

/** What a chat's settle would have to revise, counted from the same rules the settle applies. */
export type JournalSettlementFacts = {
  /** A turn record or tool call still `running`, under a key a settle can revise. */
  runningWork: boolean
  /** A pending approval or question, under a key a settle can revise. */
  pendingPrompts: boolean
  /** Handed-over sends nothing answered (`owesRecoveredDispatch`). */
  handedOverSends: number
  /** Sends accepted and never handed over. */
  queuedSends: number
  /** A working subagent roster or live background-task row; not counted on a corrupt load, whose
   *  settle leaves rosters for the rebuild. */
  liveChildWork: boolean
}

export function journalSettlementFacts(
  fold: Pick<JournalReducerState, 'items' | 'submissions'>,
  options: { settlesRosters: boolean }
): JournalSettlementFacts {
  const facts: JournalSettlementFacts = {
    runningWork: false,
    pendingPrompts: false,
    handedOverSends: 0,
    queuedSends: 0,
    liveChildWork: false
  }
  for (const submission of fold.submissions.values()) {
    if (isQueuedAgentJournalSubmission(submission)) {
      facts.queuedSends += 1
    } else if (owesRecoveredDispatch(submission)) {
      facts.handedOverSends += 1
    }
  }
  for (const item of fold.items.values()) {
    facts.liveChildWork ||= options.settlesRosters && staleSubagentRosterRevision(item) !== null
    const running = isRunningJournalTurn(item) || isRunningToolCall(item)
    const prompt = !running && openSettlementTerminalBody(item) !== null
    if ((running || prompt) && openSettlementItemIdentity(item)) {
      facts.runningWork ||= running
      facts.pendingPrompts ||= prompt
    }
  }
  return facts
}

function isRunningToolCall(item: Pick<AgentJournalRenderItem, 'body'>): boolean {
  return item.body.kind === 'tool-call' && item.body.state === 'running'
}

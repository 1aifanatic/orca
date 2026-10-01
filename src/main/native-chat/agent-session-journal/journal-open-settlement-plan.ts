// What an open owes a chat whose earlier host process is gone, one rule per kind of entity.
//
// The open's settlement plan (`structured-agent-session-open-settlement.ts`) and the stored
// "owes work" flag (`journal-session-state.ts`) both read these same rules, so the flag says a chat
// owes work exactly when its open would write something. Each rule revises its entity out of the
// state that selected it, so once the plan commits the flag reads false again.

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

/** The writer fence of an `unverifiable` turn, which only death evidence naming it revises. */
export function unverifiableTurnOwnerFence(
  item: Pick<AgentJournalRenderItem, 'itemId' | 'body'>,
  itemFence: (itemId: string) => number | undefined
): number | undefined {
  return readAgentJournalTurn(item.body)?.state === 'unverifiable'
    ? itemFence(item.itemId)
    : undefined
}

export type JournalOwedFacts = {
  /** The open writes something whatever the record says. */
  owesWork: boolean
  /** Distinct writer fences of `unverifiable` turns, sorted. */
  unverifiableOwnerFences: number[]
}

/** The plan's rules read without building rows. Rosters are skipped on a corrupt load, as the
 *  open skips them: that journal still owes a rebuild, and a write would retire the demand. */
export function owesOpenSettlement(
  fold: Pick<JournalReducerState, 'items' | 'itemFences' | 'submissions'>,
  options: { settlesRosters: boolean }
): JournalOwedFacts {
  let owesWork = false
  for (const submission of fold.submissions.values()) {
    // A queued one is a leftover: its process is gone, since a close abandons what it queued.
    if (owesRecoveredDispatch(submission) || isQueuedAgentJournalSubmission(submission)) {
      owesWork = true
      break
    }
  }
  const fences = new Set<number>()
  const itemFence = (itemId: string) => fold.itemFences.get(itemId)
  for (const item of fold.items.values()) {
    const owed = itemOwes(item, itemFence)
    owesWork ||= owed.settles || (options.settlesRosters && owed.roster)
    if (owed.unverifiableOwnerFence !== undefined) {
      fences.add(owed.unverifiableOwnerFence)
    }
  }
  return { owesWork, unverifiableOwnerFences: [...fences].sort((a, b) => a - b) }
}

type ItemOwes = { settles: boolean; roster: boolean; unverifiableOwnerFence: number | undefined }

// Per item object: a write replaces the object it revises, and an item's creating fence never
// changes, so each append judges only the items it touched.
const ITEM_OWES = new WeakMap<AgentJournalRenderItem, ItemOwes>()

function itemOwes(
  item: AgentJournalRenderItem,
  itemFence: (itemId: string) => number | undefined
): ItemOwes {
  let owes = ITEM_OWES.get(item)
  if (!owes) {
    const fence = unverifiableTurnOwnerFence(item, itemFence)
    const revisable =
      (fence !== undefined ||
        isRunningJournalTurn(item) ||
        openSettlementTerminalBody(item) !== null) &&
      openSettlementItemIdentity(item) !== null
    owes = {
      settles: revisable && fence === undefined,
      roster: staleSubagentRosterRevision(item) !== null,
      unverifiableOwnerFence: revisable ? fence : undefined
    }
    ITEM_OWES.set(item, owes)
  }
  return owes
}

/** The record-dependent rule, as the plan applies it: an `unverifiable` turn is revised only by
 *  death evidence naming its writer. An older build's evidence names no writer, so selects none. */
export function owesOnOpen(
  facts: JournalOwedFacts,
  deathEvidence: { ownerFence?: number } | null | undefined
): boolean {
  const ownerFence = deathEvidence?.ownerFence
  return (
    facts.owesWork ||
    (ownerFence !== undefined && facts.unverifiableOwnerFences.includes(ownerFence))
  )
}

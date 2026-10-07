// One row speaks for a run of starts that fail alike. Until a turn is delivered, a start that fails
// as the chat's latest start-failure row says writes no row of its own, and its rejected message is
// read under that row. Decided on the journal's lane, from the fold every earlier write landed in,
// as the batch carrying the row is planned; nothing marks the run.

import {
  readAgentSessionFailureFact,
  sameAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isStructuredAgentSessionStartFailureRow } from '../../../shared/structured-agent-session-start-failure-row-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalLifecycleMutationInput } from './journal-row-builders'

/** A batch's mutations less any start-failure row whose failure its run's row already states. */
export function withoutRestatedStartFailureRows(
  state: Pick<JournalReducerState, 'items' | 'receipts'>,
  mutations: readonly JournalLifecycleMutationInput[]
): readonly JournalLifecycleMutationInput[] {
  return mutations.filter((mutation) => {
    if (
      mutation.kind !== 'item' ||
      mutation.body.kind !== 'status' ||
      !isStructuredAgentSessionStartFailureRow(agentJournalItemKey(mutation.identity))
    ) {
      return true
    }
    const fact = readAgentSessionFailureFact(mutation.body.failure)
    return fact === undefined || !journalStartFailureAlreadyStated(state, fact)
  })
}

/** Whether the latest start-failure row states this failure, with no turn delivered since. */
export function journalStartFailureAlreadyStated(
  state: Pick<JournalReducerState, 'items' | 'receipts'>,
  failure: AgentSessionFailureFact
): boolean {
  let latest: AgentJournalRenderItem | undefined
  for (const item of state.items.values()) {
    if (
      isStructuredAgentSessionStartFailureRow(item.itemId) &&
      (latest === undefined || item.sequence > latest.sequence)
    ) {
      latest = item
    }
  }
  const stated =
    latest?.body.kind === 'status' ? readAgentSessionFailureFact(latest.body.failure) : undefined
  if (
    latest === undefined ||
    stated === undefined ||
    !sameAgentSessionFailureFact(stated, failure)
  ) {
    return false
  }
  // A send accepted after the row ends its run: the next failure is news.
  for (const receipt of state.receipts.values()) {
    if (receipt.cursor.sequence > latest.sequence) {
      return false
    }
  }
  return true
}

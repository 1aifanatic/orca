// A draft sent back to waiting rests on its submission's "never delivered"
// claim. The provider echoing that message proves the claim wrong: the first
// delivery happened. The reducer keeps such an echo apart (a rejected
// submission may not claim it), so it is read here, from the row itself.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import {
  isProviderUserMessageEcho,
  journalEchoClaimant,
  type JournalReducerState
} from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'

/** The waiting draft this appended row proves was delivered, or null. Called
 *  before the row applies, for every row, so a row that is no new provider
 *  echo of a user message returns before anything else is read. */
export function draftDeliveredByEcho(
  state: JournalReducerState,
  drafts: readonly QueuedMessageRow[],
  row: JournalRow
): string | null {
  const echoes = appendedItems(row).filter(
    (item) =>
      isProviderUserMessageEcho(item.itemId, item.body) &&
      !state.items.has(item.itemId) &&
      !state.aliases.has(item.itemId) &&
      journalEchoClaimant(state, item.itemId, item.body) === null
  )
  if (echoes.length === 0) {
    return null
  }
  // Waiting drafts some earlier hand-off of which was handed over, then rejected as never
  // delivered. One rejected before hand-over is provably unwritten: an echo matching it is some
  // other message, and must not delete the card.
  const rejectedHandOffs = new Set<string>()
  for (const submission of state.submissions.values()) {
    if (
      submission.queuedMessageId !== undefined &&
      submission.dispatchState === 'rejected' &&
      submission.handedOverAt !== undefined
    ) {
      rejectedHandOffs.add(submission.queuedMessageId)
    }
  }
  const spent = drafts.filter(
    (draft) => draft.state === 'waiting' && rejectedHandOffs.has(draft.messageId)
  )
  for (const item of echoes) {
    const fingerprint = structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: state.sessionId,
      fields: { body: item.body }
    })
    const delivered = spent.find((draft) => draft.fingerprint === fingerprint)
    if (delivered) {
      return delivered.messageId
    }
  }
  return null
}

function appendedItems(row: JournalRow): { itemId: string; body: AgentJournalItemBody }[] {
  if (row.kind === 'item') {
    return [{ itemId: row.itemId, body: row.body }]
  }
  if (row.kind === 'lifecycle-batch') {
    return row.mutations.flatMap((mutation) =>
      mutation.kind === 'item' ? [{ itemId: mutation.itemId, body: mutation.body }] : []
    )
  }
  return []
}

import { unansweredSendsRow } from './structured-agent-session-dead-generation-settlement'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { structuredAgentSessionFailureWordsContext } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

/**
 * Releases sends the provider can no longer be holding.
 *
 * A dispatch whose RPC timed out is recorded `unknown` — doubt, never proof of
 * non-delivery — and a live `unknown` reads as work still owed, so the session
 * shows working until something re-derives it. The provider reporting its thread
 * not running, with no turn open, IS that re-derivation.
 *
 * `pending` is deliberately untouched: that send's dispatch has not returned yet
 * and may be in flight right now. And `recovered` only retires the obligation —
 * it never makes a send re-deliverable, because the provider may well have run it.
 * The chat says so once, in the row every retired doubt without an exit or restart row gets.
 */
export async function releaseStructuredAgentSessionUnansweredDispatches(
  context: Pick<StructuredAgentSessionMutationContext, 'sessions'> & {
    deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'> }
  },
  input: { sessionId: string; reason: string }
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const stranded = session.journal
    .submissions()
    .filter((entry) => entry.dispatchState === 'unknown' && entry.recovered !== true)
  const [first] = stranded
  if (!first) {
    return
  }
  const fence = structuredAgentSessionConversationFence(context.deps.store, input.sessionId)
  // Written before the sends retire and keyed by the oldest, so a retry after a failed retire
  // revises this row rather than leaving the doubt silent or adding a second.
  const boundaryId = `provider-idle:${input.sessionId}:${first.clientMessageId}`
  await session.journal.appendLifecycleBatch({
    settlementId: boundaryId,
    fence,
    recovered: true,
    mutations: [
      unansweredSendsRow(
        boundaryId,
        structuredAgentSessionFailureWordsContext(context.deps.store.getRecord(input.sessionId))
      )
    ]
  })
  for (const entry of stranded) {
    await session.journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'unknown',
      // The earlier reason names a sharper fact than this one does.
      reason: entry.reason ?? input.reason,
      fence,
      recovered: true
    })
  }
}

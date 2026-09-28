// Stop's pause on queued drafts, and its lifetime. A Stop never withdraws a
// draft and no text ever travels back over the wire: the waiting frontier is
// held with `hold_reason='stopped'` — the SAME for every client — the cards
// stay published as paused, and Send-now overrides the hold per card. The
// pause dies when a user send made AFTER the Stop actually starts a turn — the
// provider accepts it — never at the host's acceptance (a send whose start
// fails would release the drafts into the same failure). A consumed draft is a
// user send too (drafts are only ever a client's own); orchestration mail and a
// restart continuation never lift. The held cards then drain after that turn. Both writes go through the draft
// store, whose commit notification publishes and wakes the drain; and both are
// bookkeeping — a failure is reported and never gates the interrupt or the send.

import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'

function reportQueuedHoldFailure(sessionId: string, step: string, error: unknown): void {
  console.warn(`[agent-session] ${step} skipped:`, {
    sessionId,
    error: error instanceof Error ? error.message : String(error)
  })
}

/** The one unsettled-card predicate Stop's hold, /clear's carry and the budget
 *  share: waiting or returned. Pending/unknown/accepted deliveries stay
 *  outside it. */
export function unsettledQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
}

/** Stop's queued-draft step, before the interrupt: hold the waiting frontier at
 *  the serialized stop step — sends accepted after it are new work, and
 *  `returned` rows never auto-send anyway. Stored on the rows, so the pause
 *  survives handle eviction and restart. A user send made BEFORE this Stop no
 *  longer lifts anything, even if its turn still starts. */
export async function holdQueuedMessagesForStop(
  ctx: AgentSessionTurnContext,
  session: StructuredAgentSessionHostSession | undefined
): Promise<void> {
  session?.userSendsAwaitingTurn?.clear()
  try {
    await ctx.journal.queuedMessages.hold({
      messageIds: unsettledQueuedMessages(ctx.journal)
        .filter((row) => row.state === 'waiting')
        .map((row) => row.messageId),
      reason: 'stopped'
    })
  } catch (error) {
    reportQueuedHoldFailure(ctx.sessionId, "Stop's queued-draft hold", error)
  }
}

/** A client's own send the host just recorded for handover — a direct send, or
 *  a draft's consumption by the drain or Send-now: remembered until the
 *  provider answers it. Only a submission still provably unwritten counts — a
 *  replay of an older send must not lift a later Stop's pause. */
export function awaitUserSendTurn(
  session: StructuredAgentSessionHostSession | undefined,
  submission: AgentJournalSubmission | undefined
): void {
  if (!session || !submission || !isQueuedAgentJournalSubmission(submission)) {
    return
  }
  session.userSendsAwaitingTurn ??= new Set()
  session.userSendsAwaitingTurn.add(submission.clientMessageId)
}

/** Every journal publish: a remembered user send the provider has now accepted
 *  started the user's turn, which lifts the stop-shaped holds — a Stop's, a
 *  /clear carry's, or a restart's (that row is adopted into this instance).
 *  One refused, or gone from the journal, is forgotten with the holds intact.
 *  `send_failed` holds stay — they release only through an explicit Send. */
export function releaseQueuePauseOnUserTurnStart(
  sessionId: string,
  session: StructuredAgentSessionHostSession | undefined
): void {
  const awaiting = session?.userSendsAwaitingTurn
  if (!session || !awaiting || awaiting.size === 0) {
    return
  }
  let started = false
  for (const clientMessageId of awaiting) {
    const state = session.journal.submission(clientMessageId)?.dispatchState
    if (state === 'accepted') {
      started = true
    }
    if (state === undefined || state === 'accepted' || state === 'rejected') {
      awaiting.delete(clientMessageId)
    }
  }
  if (started) {
    void releaseStopHeldQueuedMessages(sessionId, session.journal)
  }
}

async function releaseStopHeldQueuedMessages(
  sessionId: string,
  journal: AgentSessionJournal
): Promise<void> {
  try {
    await journal.queuedMessages.releaseStopHolds({
      hostInstance: structuredAgentSessionHostInstance()
    })
  } catch (error) {
    reportQueuedHoldFailure(sessionId, "a started user turn's stopped-hold release", error)
  }
}

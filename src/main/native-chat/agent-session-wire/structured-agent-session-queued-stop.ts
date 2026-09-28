// Stop's pause on queued drafts, and its lifetime. A Stop never withdraws a
// draft and no text ever travels back over the wire: the waiting frontier is
// held with `hold_reason='stopped'` — the SAME for every client — the cards
// stay published as paused, and Send-now overrides the hold per card. The
// pause dies when the user next STARTS a turn (a client's own ordinary send —
// never a queued draft's conversion, orchestration mail or a restart
// continuation): the held cards then drain
// after that turn. Both writes go through the draft store, whose commit
// notification publishes and wakes the drain; and both are bookkeeping —
// a failure is reported and never gates the interrupt or the send.

import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { unsettledQueuedMessages } from './structured-agent-session-queued-mutations'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'

function reportQueuedHoldFailure(sessionId: string, step: string, error: unknown): void {
  console.warn(`[agent-session] ${step} skipped:`, {
    sessionId,
    error: error instanceof Error ? error.message : String(error)
  })
}

/** Stop's queued-draft step, before the interrupt: hold the waiting frontier at
 *  the serialized stop step — sends accepted after it are new work, and
 *  `returned` rows never auto-send anyway. Stored on the rows, so the pause
 *  survives handle eviction and restart. */
export async function holdQueuedMessagesForStop(ctx: AgentSessionTurnContext): Promise<void> {
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

/** The pause's death: the user starting a turn supersedes whatever paused the
 *  queue — a Stop, a /clear carry, or a host restart (that row is adopted into
 *  this instance) — so those holds lift in the send's own serialized step and
 *  the cards drain once that turn settles. `send_failed` holds stay — they
 *  release only through an explicit Send. */
export async function releaseStopHeldQueuedMessages(ctx: AgentSessionTurnContext): Promise<void> {
  try {
    await ctx.journal.queuedMessages.releaseStopHolds({
      hostInstance: structuredAgentSessionHostInstance()
    })
  } catch (error) {
    reportQueuedHoldFailure(ctx.sessionId, "a send's stopped-hold release", error)
  }
}

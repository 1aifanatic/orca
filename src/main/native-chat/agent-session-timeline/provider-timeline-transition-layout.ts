// The writes one non-text event's transition carries, in order: the text owed ahead of it, its
// settlement, then its rows.

import {
  providerTimelineSettlementId,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision
} from './provider-timeline-decision'
import type { ProviderTimelinePlan } from './provider-timeline-plan'
import { providerKey, turnOf } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineTextStreams } from './provider-timeline-text-streams'

/** Paces the queue only: a settlement's mutations are the journal's to choose. */
const SETTLEMENT_RESERVED_BYTES = 64 * 1024

/** Text owed ahead of the event lands first; a row-writing event also ends the messages it
 *  separates: anonymous ones of its producer, every stream of a turn it ends, all on a session end. */
export function planProviderTimelineBarrier(
  input: {
    streams: ProviderTimelineTextStreams
    state: ProviderTimelineState
    context: ProviderTimelineContext
  },
  plan: ProviderTimelinePlan,
  event: ProviderTimelineDecidedEvent,
  decision: ProviderTimelineDecision
): void {
  const { streams, state, context } = input
  // A full snapshot of a streamed message replaces what streamed, so that text is not flushed.
  const replaced = decision.closes ? streams.get(decision.closes) : undefined
  streams.planFlush(plan, replaced)
  if (replaced) {
    streams.planRelease(plan, (stream) => stream === replaced)
  }
  if (event.type === 'session.ended') {
    streams.planRelease(plan, () => true)
    return
  }
  if (event.type === 'turn.end' || event.type === 'turn.open') {
    const ending =
      event.type === 'turn.end' && event.turn !== undefined
        ? context.rows.turn(providerKey(event.turn)).itemId
        : state.open?.itemId
    streams.planRelease(
      plan,
      (stream) =>
        (!stream.named && stream.producer?.agentId === undefined) ||
        (ending !== undefined && turnOf(stream.scope) === ending)
    )
    return
  }
  if (event.type !== 'input.accepted') {
    const agentId = 'producer' in event ? event.producer?.agentId : undefined
    streams.planRelease(plan, (stream) => !stream.named && stream.producer?.agentId === agentId)
  }
}

/** The event's own settlement and rows, after the text it flushed. */
export function planProviderTimelineWrites(
  context: ProviderTimelineContext,
  plan: ProviderTimelinePlan,
  decision: ProviderTimelineDecision,
  serial: () => number
): void {
  const { settle } = decision
  if (settle) {
    plan.settlement({
      settlementId: providerTimelineSettlementId(context, serial(), settle.what),
      reservedBytes: SETTLEMENT_RESERVED_BYTES,
      resolve: settle.resolve
    })
  }
  for (const write of decision.writes ?? []) {
    plan.item(
      {
        reservedBytes: write.reservedBytes,
        resolve: write.resolve,
        options: write.options
      },
      write.lifecycle
    )
  }
}

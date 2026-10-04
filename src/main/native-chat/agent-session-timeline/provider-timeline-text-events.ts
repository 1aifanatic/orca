// Text events: planning-side streams, admitted like every other event.

import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type {
  ProviderTimelineApplyHost,
  ProviderTimelineApplyResult,
  ProviderTimelineInFlight
} from './provider-timeline-apply-host'
import { PROVIDER_TIMELINE_OVER_BUDGET } from './provider-timeline-budget'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import { ProviderTimelinePlan } from './provider-timeline-plan'

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function applyProviderTimelineTextDelta(
  host: ProviderTimelineApplyHost,
  event: Extract<ProviderTimelineEvent, { type: 'text.delta' }>
): ProviderTimelineApplyResult {
  const { streams } = host
  const forecast = host.forecast()
  if (forecast.ended) {
    return { admission: ADMITTED, dropped: 'session-ended' }
  }
  const journal = host.journal()
  const plan = new ProviderTimelinePlan()
  let stream = streams.get(streams.key(event.item, event.join, forecast))
  if (stream && !streams.continues(stream, event.channel, event.producer)) {
    if (stream.named) {
      return { admission: ADMITTED, dropped: 'stream-mismatch' }
    }
    // The anonymous stream's next message: what the last one owes lands first.
    streams.planFlush(plan)
    const ended = stream
    streams.planRelease(plan, (each) => each === ended)
    stream = undefined
  }
  if (!stream) {
    if ('id' in event.item && settledNamedItem(host, event, journal)) {
      return { admission: ADMITTED, dropped: 'item-settled' }
    }
    stream = streams.start({
      item: event.item,
      join: event.join,
      channel: event.channel,
      producer: event.producer,
      state: forecast
    })
    if (!host.admits({ key: stream.key, bytes: stream.bytes })) {
      return { admission: PROVIDER_TIMELINE_OVER_BUDGET }
    }
  }
  streams.planAppend(plan, stream, event.text)
  return { admission: host.submit(plan, { executed: false, commit: undefined }) }
}

/** A named delta for an item this run closed, or one the journal holds in a settled turn. */
function settledNamedItem(
  host: ProviderTimelineApplyHost,
  event: Extract<ProviderTimelineEvent, { type: 'text.delta' }>,
  journal: StructuredAgentSessionTransitionJournal | null
): boolean {
  const { context } = host
  const forecast = host.forecast()
  if (!('id' in event.item)) {
    return false
  }
  const join = {
    family: 'item' as const,
    key: { source: 'provider' as const, value: event.item.id },
    thread: event.join?.thread ?? null
  }
  if (forecast.closed.has(context.joins.reference(join, forecast.namespace))) {
    return true
  }
  const row = context.joins.find(join, journal, forecast.namespace)
  const turnItemId = row?.scope.kind === 'turn' ? row.scope.turnItemId : null
  return turnItemId !== null && forecast.status({ itemId: turnItemId }, journal) === 'settled'
}

export function applyProviderTimelineTextClose(
  host: ProviderTimelineApplyHost,
  event: Extract<ProviderTimelineEvent, { type: 'text.close' }>
): ProviderTimelineApplyResult {
  const { streams } = host
  const forecast = host.forecast()
  if (forecast.ended) {
    return { admission: ADMITTED, dropped: 'session-ended' }
  }
  const stream = streams.get(streams.key(event.item, event.join, forecast))
  if (!stream) {
    return { admission: ADMITTED, dropped: 'stream-unknown' }
  }
  const plan = new ProviderTimelinePlan()
  streams.planFlush(plan, stream)
  streams.planClose(plan, stream, event.text)
  const entry: ProviderTimelineInFlight = {
    executed: false,
    commit: stream.named ? (state) => state.closed.set(stream.key, stream.turnItemId) : undefined
  }
  plan.atExecution(() => {
    entry.executed = true
  })
  return { admission: host.submit(plan, entry) }
}

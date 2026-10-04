// The writes one non-text event may need, laid out before anything is decided: the text owed
// ahead of it, then its fixed settlement and item slots, each resolved when it runs.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import { unhandledProviderFrameJournalItem } from '../agent-session-wire/unhandled-provider-frame'
import type { ProviderTimelineApplyHost } from './provider-timeline-apply-host'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision
} from './provider-timeline-decisions'
import type { ProviderTimelinePlan } from './provider-timeline-plan'

/** Room for a settled turn row and its context facts. */
const TURN_ROW_RESERVED_BYTES = 64 * 1024
/** Identities a scheme spells stay well under this; item rows reserve it for theirs. */
const IDENTITY_PLACEHOLDER = { provider: 'orca', clientMessageId: 'x'.repeat(1024) } as const

/** Text owed ahead of the event lands first; a row-writing event also ends the messages it
 *  separates: anonymous ones of its producer, every stream of a turn it ends, all on a session end. */
export function planProviderTimelineBarrier(
  host: ProviderTimelineApplyHost,
  plan: ProviderTimelinePlan,
  event: ProviderTimelineDecidedEvent,
  decision: ProviderTimelineDecision,
  /** Execution: whether the event's own decision wrote, so the boundary it draws is real. */
  landed: () => boolean
): void {
  const { streams, context } = host
  const forecast = host.forecast()
  // A full snapshot of a streamed message replaces what streamed, so that text is not flushed.
  const replaced = decision.closes ? streams.get(decision.closes) : undefined
  streams.planFlush(plan, replaced)
  if (replaced) {
    streams.planRelease(plan, (stream) => stream === replaced, landed)
  }
  if (event.type === 'session.ended' || event.type === 'session.reset') {
    streams.planRelease(plan, () => true, landed)
    streams.planRetire(plan)
    return
  }
  if (event.type === 'turn.end' || event.type === 'turn.open') {
    const ending =
      event.type === 'turn.end' && event.turn !== undefined
        ? context.joins.turn({ source: 'provider', value: event.turn }, forecast.namespace).itemId
        : forecast.open?.itemId
    streams.planRelease(
      plan,
      (stream) =>
        (!stream.named && stream.producer?.agentId === undefined) ||
        (ending !== undefined && streams.rowTurn(stream) === ending),
      landed
    )
    // The turn that really ended is the journal's: its streams stop wherever planning placed them.
    streams.planRetire(plan)
    return
  }
  if (event.type !== 'input.accepted') {
    const agentId = 'producer' in event ? event.producer?.agentId : undefined
    streams.planRelease(
      plan,
      (stream) => !stream.named && stream.producer?.agentId === agentId,
      landed
    )
  }
}

export function planProviderTimelineSlots(
  host: ProviderTimelineApplyHost,
  plan: ProviderTimelinePlan,
  event: ProviderTimelineDecidedEvent,
  decide: (journal: StructuredAgentSessionTransitionJournal) => ProviderTimelineDecision | null
): void {
  const { context } = host
  const settlement = (what: string) =>
    plan.settlement({
      settlementId: context.settlementId(what),
      reservedBytes: TURN_ROW_RESERVED_BYTES,
      resolve: (journal) => decide(journal)?.settle ?? []
    })
  const item = (reservedBytes: number, lifecycle: boolean) =>
    plan.item(
      {
        reservedBytes,
        resolve: (journal) => decide(journal)?.write ?? null,
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      },
      lifecycle
    )
  switch (event.type) {
    case 'turn.open':
      settlement('turn-superseded')
      item(TURN_ROW_RESERVED_BYTES, true)
      return
    case 'turn.end':
      settlement('turn-end')
      return
    case 'request.withdrawn':
      settlement('request-withdrawn')
      return
    case 'session.ended':
      settlement('session-end')
      return
    case 'session.reset':
      settlement('session-reset')
      return
    case 'input.accepted':
    case 'context.usage':
      item(TURN_ROW_RESERVED_BYTES, true)
      return
    case 'item.open':
    case 'item.update':
    case 'item.close':
      item(
        estimateStructuredAgentSessionItemBytes(IDENTITY_PLACEHOLDER, event.body),
        event.type !== 'item.update'
      )
      return
    case 'request.open':
      item(estimateStructuredAgentSessionItemBytes(IDENTITY_PLACEHOLDER, event.body), true)
      return
    case 'provider.frame': {
      const frame = unhandledProviderFrameJournalItem(context.agent, event.frameKind, event.payload)
      if (frame) {
        item(estimateStructuredAgentSessionItemBytes(IDENTITY_PLACEHOLDER, frame.body), false)
      }
    }
  }
}

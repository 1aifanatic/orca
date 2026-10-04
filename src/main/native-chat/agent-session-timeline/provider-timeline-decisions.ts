// What each non-text event does: one rule set, run twice.
//
// Planning runs it on the forecast and the journal as it stands, to answer `apply` (dropped or
// not, and what it would hold open) without writing or allocating anything. Execution runs it
// again in the event's first resolver, on the ledger and the fold at that point in the journal's
// write queue: only then are rows placed, ordinals and incarnations taken, and the ledger changed.
// So when the two disagree — before bind, after a restart, behind a replay the journal rejects —
// the journal's answer is the one that lands, and the ledger follows it.

import {
  decideFrame,
  decideItem,
  decideRequest,
  decideWithdrawal
} from './provider-timeline-item-decisions'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput
} from './provider-timeline-decision'
import {
  decideContextUsage,
  decideInput,
  decideReplayedInput,
  decideSessionEnd,
  decideTurnEnd,
  decideTurnOpen
} from './provider-timeline-turn-decisions'

export type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDropRule
} from './provider-timeline-decision'

export function decideProviderTimelineEvent(
  input: ProviderTimelineDecisionInput,
  event: ProviderTimelineDecidedEvent
): ProviderTimelineDecision {
  if (input.state.ended && event.type !== 'session.reset') {
    return { dropped: 'session-ended' }
  }
  switch (event.type) {
    case 'input.accepted':
      return decideInput(input, event)
    case 'input.replayed':
      return decideReplayedInput(input, event)
    case 'turn.open':
      return decideTurnOpen(input, event)
    case 'turn.end':
      return decideTurnEnd(input, event)
    case 'item.open':
    case 'item.update':
    case 'item.close':
      return decideItem(input, event)
    case 'request.open':
      return decideRequest(input, event)
    case 'request.withdrawn':
      return decideWithdrawal(input, event)
    case 'context.usage':
      return decideContextUsage(input, event)
    case 'provider.frame':
      return decideFrame(input, event)
    case 'session.ended':
      return decideSessionEnd(input, event.verdict, (state) => {
        state.ended = true
        state.endSession()
      })
    case 'session.reset':
      // Nothing ended the old session's open work, so it is lost, not interrupted; the resolver
      // finds nothing when an end already settled it.
      return decideSessionEnd(input, { state: 'unverifiable' }, (state) => {
        state.reset(event.namespace)
        if (input.execute) {
          input.context.joins.reset(event.namespace)
        }
      })
  }
}

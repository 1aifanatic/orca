// What the event appliers share with the assembler that owns them.

import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineHold } from './provider-timeline-budget'
import type { ProviderTimelineContext } from './provider-timeline-context'
import type { ProviderTimelineDropRule } from './provider-timeline-decisions'
import type { ProviderTimelinePlan } from './provider-timeline-plan'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineTextStreams } from './provider-timeline-text-streams'

export type ProviderTimelineApplyResult = {
  /** The sink's answer for the event's writes; refused means nothing changed. */
  admission: StructuredAgentSessionSinkAdmission
  dropped?: ProviderTimelineDropRule
}

/** An admitted transition that has not landed: what it changes in the forecast until it does. */
export type ProviderTimelineInFlight = {
  executed: boolean
  commit: ((state: ProviderTimelineState) => void) | undefined
}

export type ProviderTimelineApplyHost = {
  context: ProviderTimelineContext
  streams: ProviderTimelineTextStreams
  /** The forecast now; it is replaced as transitions land. */
  forecast(): ProviderTimelineState
  journal(): StructuredAgentSessionTransitionJournal | null
  admits(hold: ProviderTimelineHold): boolean
  submit(
    plan: ProviderTimelinePlan,
    entry: ProviderTimelineInFlight
  ): StructuredAgentSessionSinkAdmission
}

// What a provider adapter tells the host about its child's life, for the host's lifecycle handler.

import type {
  StructuredAgentSessionEndedEvent,
  StructuredAgentSessionStartedEvent
} from './structured-agent-session-adapter'

/** A close that gave up proving this child's exit has since seen its root exit. Evidence to retry
 *  the stop owed for this child, not a verdict: that stop's own proof decides. */
export type StructuredAgentSessionExitAfterCloseEvent = {
  type: 'exitAfterClose'
  sessionId: string
  fence: number
  acquisitionGeneration: string
}

export type StructuredAgentSessionLifecycleEvent =
  | StructuredAgentSessionEndedEvent
  | StructuredAgentSessionStartedEvent
  | StructuredAgentSessionExitAfterCloseEvent

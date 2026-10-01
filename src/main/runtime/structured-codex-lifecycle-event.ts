import type { CodexStructuredSessionEvent } from '../codex/codex-structured-session-state'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/** The Codex adapter events the host's lifecycle handler consumes. A close the host asked for and
 *  saw land is settled by that close, so its `ended` stays here. */
export function structuredCodexLifecycleEvent(
  event: CodexStructuredSessionEvent
): StructuredAgentSessionLifecycleEvent | null {
  if (event.type === 'exitAfterClose') {
    return event
  }
  return event.type === 'ended' && 'cause' in event && event.cause === 'unexpected-exit'
    ? event
    : null
}

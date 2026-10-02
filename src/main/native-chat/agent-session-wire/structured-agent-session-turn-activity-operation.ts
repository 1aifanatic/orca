import type { AgentSessionTurnActivity } from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionSinkOperation } from './structured-agent-session-event-sink-queue'

/** One live activity publish. Coalesced, so a newer one replaces any still queued; refused like
 *  any ordinary write when the queue is full and holds none to replace. */
export function turnActivityOperation(
  activity: AgentSessionTurnActivity | null
): Omit<StructuredAgentSessionSinkOperation, 'sequence'> {
  return {
    bytes: Buffer.byteLength(JSON.stringify(activity), 'utf8') + 64,
    coalescingKey: 'turn-activity',
    run: (bound) => bound.publish(activity)
  }
}

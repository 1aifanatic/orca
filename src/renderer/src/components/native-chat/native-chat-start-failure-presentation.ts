import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'

/** What the composer's disabled Send is saying right now; null while Send is not blocked. */
export type NativeChatGateReason = AgentSessionUnavailable['reason'] | null

/** The disabled Send already states this failure, so saying it again is one failure twice. */
export function isNativeChatFailureShownByGate(
  failure: UnreadAgentSessionFailureFact,
  gateReason: NativeChatGateReason
): boolean {
  return gateReason !== null && failure.kind === gateReason
}

/** A start-failure row the gate states; unsent messages keep their own rejection reason. */
export function isNativeChatHiddenStartFailureRow(
  item: AgentJournalRenderItem,
  gateReason: NativeChatGateReason
): boolean {
  if (item.body.kind !== 'status' || !isStructuredAgentSessionStartFailureRow(item.itemId)) {
    return false
  }
  const failure = item.body.failure
  return failure !== undefined && isNativeChatFailureShownByGate(failure, gateReason)
}

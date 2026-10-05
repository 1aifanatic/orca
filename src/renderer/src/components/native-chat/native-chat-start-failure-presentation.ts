import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'

export function isNativeChatAvailabilityFailure(failure: UnreadAgentSessionFailureFact): boolean {
  return failure.kind === 'notSignedIn' || failure.kind === 'cliMissing'
}

/** Send explains availability; unsent messages keep their own rejection reason. */
export function isNativeChatHiddenStartFailureRow(item: AgentJournalRenderItem): boolean {
  if (item.body.kind !== 'status' || !isStructuredAgentSessionStartFailureRow(item.itemId)) {
    return false
  }
  const failure = item.body.failure
  return failure !== undefined && isNativeChatAvailabilityFailure(failure)
}

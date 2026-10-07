import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'

// Desktop states a start that failed for sign-in or a missing CLI on the disabled Send alone, as
// the same sentence a send would get; the start's own line and row would only repeat it.

export function isNativeChatSendGateFailure(failure: { kind: string } | undefined): boolean {
  return failure?.kind === 'notSignedIn' || failure?.kind === 'cliMissing'
}

export function isNativeChatHiddenStartFailureRow(item: AgentJournalRenderItem): boolean {
  return (
    item.body.kind === 'status' &&
    isStructuredAgentSessionStartFailureRow(item.itemId) &&
    isNativeChatSendGateFailure(item.body.failure)
  )
}

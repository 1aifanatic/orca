import type { AgentSessionUnavailable } from '../../../../shared/agent-session-availability'
import type { UnreadAgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'

/** What the host says now about this chat's sign-in and CLI: the reason the disabled Send states,
 *  `accountVerified` once its probe found both fine after the failure, or null for no answer. */
export type NativeChatGateReason = AgentSessionUnavailable['reason'] | 'accountVerified' | null

export function nativeChatGateReason(
  unavailable: AgentSessionUnavailable | null,
  accountVerified: boolean
): NativeChatGateReason {
  return unavailable?.reason ?? (accountVerified ? 'accountVerified' : null)
}

/** The disabled Send states this failure, or the host re-checked and it no longer holds; either
 *  way the start's own line is not current. With no answer, the line shows. */
export function isNativeChatFailureShownByGate(
  failure: UnreadAgentSessionFailureFact,
  gateReason: NativeChatGateReason
): boolean {
  return gateReason === 'accountVerified'
    ? failure.kind === 'notSignedIn' || failure.kind === 'cliMissing'
    : gateReason !== null && failure.kind === gateReason
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

/** The newest start failure for a sign-in or CLI reason, so its arrival reads the host's verdict. */
export function nativeChatAvailabilityStartFailureKey(
  items: readonly AgentJournalRenderItem[]
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (isNativeChatHiddenStartFailureRow(item, 'accountVerified')) {
      return `${item.itemId}:${item.revision}`
    }
  }
  return null
}

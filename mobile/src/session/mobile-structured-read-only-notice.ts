import {
  agentSessionReadOnlyNoticeParts,
  type AgentSessionReadOnlyReason
} from '../../../src/shared/agent-session-read-only'
import { agentSessionWriteNoticeEnglish } from '../../../src/shared/agent-session-refusal-notice'

/** The phone's words for why the host keeps a chat read-only: desktop's sentences, in English. */
export function mobileReadOnlyNotice(
  reason: AgentSessionReadOnlyReason | undefined
): string | null {
  const parts = agentSessionReadOnlyNoticeParts(reason)
  return parts ? agentSessionWriteNoticeEnglish(parts) : null
}

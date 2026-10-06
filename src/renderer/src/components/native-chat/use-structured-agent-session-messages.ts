import { useMemo } from 'react'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import type { NativeChatGateReason } from './native-chat-start-failure-presentation'

export function useStructuredAgentSessionMessages(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  gateReason: NativeChatGateReason
) {
  return useMemo(
    () => projectStructuredAgentSessionMessages(items, outbox, submissions, gateReason),
    [gateReason, items, outbox, submissions]
  )
}

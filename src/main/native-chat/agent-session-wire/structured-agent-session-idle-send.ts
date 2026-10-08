import { refuse } from '../../../shared/agent-session-wire'
import { isUnsettledQueuedMessage } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { structuredQueueHold } from './structured-agent-session-queued-messages'
import {
  sendPreparation,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'

/** Mail waits before admission; a deferred pointer owns no draft or send receipt. */
export function idleSendPreparation(
  context: StructuredAgentSessionMutationContext,
  envelope: Parameters<typeof sendPreparation>[1],
  arrival: Parameters<typeof sendPreparation>[2]
): ReturnType<typeof sendPreparation> {
  const prepare = sendPreparation(context, envelope, arrival)
  return async (ledger) => {
    const prepared = await prepare(ledger)
    if (!prepared.ok || ledger === 'replay') {
      return prepared
    }
    const session = context.sessions.get(envelope.sessionId)
    if (!session) {
      return prepared
    }
    const record = context.deps.store.getRecord(envelope.sessionId)
    const blocked = structuredAgentSessionSendBlock(record)
    if (blocked) {
      return blocked
    }
    const hold = structuredQueueHold({
      journal: session.journal,
      record,
      fence: structuredAgentSessionConversationFence(context.deps.store, envelope.sessionId)
    })
    const reason =
      hold === 'prompt'
        ? 'promptPending'
        : hold === 'working'
          ? 'turnActive'
          : session.journal.queuedMessages.list().some(isUnsettledQueuedMessage)
            ? 'messagesUnsettled'
            : null
    return reason
      ? {
          ok: false,
          refusal: refuse(
            'agent_session_operation_invalid',
            { reason },
            'Mail delivery is waiting for the conversation to be ready.'
          )
        }
      : prepared
  }
}

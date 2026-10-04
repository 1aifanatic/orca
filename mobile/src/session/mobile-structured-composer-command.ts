import type { AgentSessionConversationCommandResult } from '../../../src/shared/agent-session-conversation-command'
import {
  dispatchStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionComposerCommand,
  type StructuredAgentSessionComposerOptions
} from '../../../src/shared/structured-agent-session-composer'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import { requestStructuredAgentSessionMutation } from './mobile-structured-agent-session-rpc'
import { structuredSessionOperationId } from './structured-session-operation-id'

export async function dispatchMobileStructuredCommand(input: {
  text: string
  hasAttachments: boolean
  client: RpcClient
  sessionId: string
  fence: number
  pending: { current: boolean }
  controller: StructuredAgentSessionComposerOptions
  canRun: () => boolean
  /** Whether the loaded journal shows the message the host recorded under this id. */
  recorded: (clientMessageId: string) => boolean
  onError: (message: string) => void
  timeoutMs: number
}): Promise<MobileNativeChatSendOutcome | null> {
  if (input.pending.current) {
    return 'rejected'
  }
  if (!isStructuredAgentSessionComposerCommand(input.text, input.controller.agent)) {
    return null
  }
  if (input.hasAttachments) {
    input.onError('Remove attachments before using a chat-session command.')
    return 'rejected'
  }
  let unknown = false
  const outcome = await dispatchStructuredAgentSessionComposerCommand(input.text, {
    ...input.controller,
    runConversationCommand: async (command) => {
      if (!input.canRun()) {
        return {
          accepted: false,
          error: 'Wait for pending work to finish before using this command.'
        }
      }
      input.pending.current = true
      const clientOperationId = structuredSessionOperationId()
      try {
        const result =
          await requestStructuredAgentSessionMutation<AgentSessionConversationCommandResult>({
            client: input.client,
            sessionId: input.sessionId,
            expectedRuntimeFence: input.fence,
            method: 'agentSession.conversationCommand',
            fingerprintMethod: 'agentSession.conversationCommand',
            fields: { command },
            clientOperationId,
            timeoutMs: Math.max(input.timeoutMs, 195_000)
          })
        if (
          result.status === 'unknown' ||
          (result.status === 'accepted' && result.value.state === 'unknown')
        ) {
          unknown = true
          return {
            accepted: false,
            error: 'Conversation operation was not confirmed.'
          }
        }
        if (result.status !== 'accepted') {
          return { accepted: false, error: result.message }
        }
        // The host answered for a command it recorded: its row in the chat says how it went, so
        // no banner repeats it and the text stays the row's, not the composer's.
        if (result.value.state === 'completed' && input.recorded(clientOperationId)) {
          return { accepted: true, error: null }
        }
        return { accepted: !result.value.error, error: result.value.error ?? null }
      } finally {
        input.pending.current = false
      }
    }
  })
  if (outcome.error) {
    input.onError(outcome.error)
  }
  return unknown ? 'unknown' : outcome.accepted ? 'accepted' : 'rejected'
}

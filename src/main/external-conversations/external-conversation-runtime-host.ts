// The runtime's own chats, bots and workers, as the conversation seam reaches them.
import { runtimeBotConversations } from '../bots/bot-conversations'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeChatHost } from './external-conversation-chat'
import type { ExternalConversationHost } from './external-conversation-host'

export function runtimeConversationHost(runtime: OrcaRuntimeService): ExternalConversationHost {
  return {
    chat: runtimeChatHost(runtime),
    bots: runtimeBotConversations(runtime),
    // Only workers a turn its thread woke started show there; others stay in Orca.
    workers: {
      read: async (sessionIds) => {
        const { readConnectorWorkerActivity } =
          await import('../runtime/rpc/methods/orchestration/worker/connector-worker-activity')
        return readConnectorWorkerActivity(runtime, sessionIds)
      }
    }
  }
}

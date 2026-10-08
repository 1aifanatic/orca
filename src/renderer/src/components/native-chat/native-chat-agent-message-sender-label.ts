import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import {
  useStructuredChatTabConversationName,
  useStructuredOrchestrationSessionId
} from '@/runtime/structured-conversation-name'
import {
  structuredAgentSessionOwnerForTab,
  resolveStructuredAgentSessionOwner
} from '@/runtime/structured-agent-session-owner'
import type { AgentMessageSender } from '../../../../shared/agent-session-message-source'
import type { Tab } from '../../../../shared/tab-types'

export function unnamedSenderLabel(): string {
  return translate('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

/** The name recorded on the message. */
export function agentMessageSenderLabel(sender: AgentMessageSender): string {
  return sender.name ?? unnamedSenderLabel()
}

function findChatTab(
  state: AppState,
  sessionId: string,
  executionHostId: string | null
): Tab | undefined {
  const tabsByWorktree = state.unifiedTabsByWorktree
  for (const worktreeId in tabsByWorktree) {
    const tab = structuredChatTabBySessionId(tabsByWorktree, worktreeId, sessionId)
    if (tab && structuredAgentSessionOwnerForTab(state, tab) === executionHostId) {
      return tab
    }
    // A workspace bucket can mirror identical session ids from two hosts.
    const qualified =
      tab &&
      tabsByWorktree[worktreeId]?.find(
        (candidate) =>
          candidate.contentType === 'agent-session' &&
          candidate.entityId === sessionId &&
          structuredAgentSessionOwnerForTab(state, candidate) === executionHostId
      )
    if (qualified) {
      return qualified
    }
  }
  return undefined
}

/** Live chat names follow the host's current clear lineage; CLI names stay as recorded. */
export function useAgentMessageSenderLabel(
  sender: AgentMessageSender,
  chatWorktreeId: string | null
): string {
  const { address, orcaSessionId } = sender.party
  const local = !address.startsWith('dispatch:')
  const owner = useAppStore((state) =>
    chatWorktreeId ? resolveStructuredAgentSessionOwner(state, chatWorktreeId) : null
  )
  const sessionId = useStructuredOrchestrationSessionId(owner, local ? orcaSessionId : null)
  const chatTab = useAppStore((state) =>
    local && sessionId ? findChatTab(state, sessionId, owner) : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const ownName = chatTab ? chatTab.customLabel?.trim() || conversationName : null
  return ownName || sender.name || chatTab?.label.trim() || unnamedSenderLabel()
}

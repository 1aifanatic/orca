import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'
import { useStructuredChatTabConversationName } from '@/runtime/structured-conversation-name'
import type { AgentMessageSender } from '../../../../shared/agent-session-message-source'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import { resolveAgentRowPaneLiveTitle } from '../dashboard/agent-row-pane-live-title'

export function unnamedSenderLabel(): string {
  return translate('components.native-chat.agentMessage.unnamedSender', 'an agent')
}

/** The name the message recorded when it was sent. */
export function agentMessageSenderLabel(sender: AgentMessageSender): string {
  return sender.name ?? unnamedSenderLabel()
}

type SenderTitleState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'settings'
>

/** What the sidebar's agent row calls the agent in terminal `handle`; null when this window shows
 *  no agent there or its row has no name of its own. */
export function terminalAgentRowName(state: SenderTitleState, handle: string): string | null {
  for (const paneKey in state.agentStatusByPaneKey) {
    const entry = state.agentStatusByPaneKey[paneKey]
    if (entry?.terminalHandle !== handle) {
      continue
    }
    const pane = parsePaneKey(paneKey)
    const tab = pane ? findTerminalTab(state, entry.worktreeId, pane.tabId) : undefined
    if (!pane || !tab) {
      return null
    }
    return getAgentRowConversationName(
      tab,
      entry.agentType,
      state.settings?.tabAutoGenerateTitle === true,
      resolveAgentRowPaneLiveTitle(
        state.terminalLayoutsByTabId?.[tab.id],
        state.runtimePaneTitlesByTabId?.[tab.id],
        pane.leafId
      ),
      entry.providerSession?.id
    )
  }
  return null
}

function findTerminalTab(
  state: SenderTitleState,
  worktreeId: string | undefined,
  tabId: string
): AppState['tabsByWorktree'][string][number] | undefined {
  if (worktreeId) {
    return state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
  }
  for (const tabs of Object.values(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return tab
    }
  }
  return undefined
}

function findChatTab(
  tabsByWorktree: AppState['unifiedTabsByWorktree'],
  sessionId: string
): Tab | undefined {
  for (const worktreeId in tabsByWorktree) {
    const tab = structuredChatTabBySessionId(tabsByWorktree, worktreeId, sessionId)
    if (tab) {
      return tab
    }
  }
  return undefined
}

/**
 * The sender's own name as Orca shows it now (its chat's rename or saved name, or its sidebar agent
 * row's name); otherwise the name the message recorded, which the host chose the same way and
 * falls back to its task or agent label. A sender on another host (`dispatch:<id>`) is never
 * looked up here.
 */
export function useAgentMessageSenderLabel(sender: AgentMessageSender): string {
  const { address, orcaSessionId, terminalHandle } = sender.party
  const local = !address.startsWith('dispatch:')
  const chatTab = useAppStore((state) =>
    local && orcaSessionId ? findChatTab(state.unifiedTabsByWorktree, orcaSessionId) : undefined
  )
  const conversationName = useStructuredChatTabConversationName(chatTab)
  const terminalName = useAppStore((state) =>
    local && !chatTab && terminalHandle ? terminalAgentRowName(state, terminalHandle) : null
  )
  const ownName = chatTab ? chatTab.customLabel?.trim() || conversationName : terminalName
  return ownName || sender.name || chatTab?.label.trim() || unnamedSenderLabel()
}

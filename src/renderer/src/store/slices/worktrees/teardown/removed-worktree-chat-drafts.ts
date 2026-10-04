import type { AppState } from '../../../types'
import {
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsForTab,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'

/** Which unsent chat drafts a workspace's open tabs own: conversation draft keys and terminal tab
 *  ids (each tab's pane drafts). */
export type WorkspaceChatDraftKeys = {
  readonly conversations: readonly string[]
  readonly terminalTabIds: readonly string[]
}

/**
 * Read before a user's delete goes to the host: the host announces the removal before it replies,
 * and the listing refresh that starts can drop the tab lists these keys are found through.
 */
export function captureWorkspaceChatDraftKeys(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  workspaceIds: Iterable<string>
): WorkspaceChatDraftKeys {
  const conversations: string[] = []
  const terminalTabIds: string[] = []
  for (const workspaceId of workspaceIds) {
    for (const tab of state.unifiedTabsByWorktree[workspaceId] ?? []) {
      if (tab.contentType === 'agent-session') {
        conversations.push(structuredAgentSessionDraftScopeKey(tab.entityId))
      }
    }
    for (const tab of state.tabsByWorktree[workspaceId] ?? []) {
      terminalTabIds.push(tab.id)
    }
  }
  return { conversations, terminalTabIds }
}

/** Only after the delete succeeded: a refused or failed one keeps the drafts. */
export function deleteWorkspaceChatDrafts(keys: WorkspaceChatDraftKeys): void {
  for (const key of keys.conversations) {
    deleteNativeChatComposerDraft(key)
  }
  for (const tabId of keys.terminalTabIds) {
    deleteNativeChatComposerDraftsForTab(tabId)
  }
}

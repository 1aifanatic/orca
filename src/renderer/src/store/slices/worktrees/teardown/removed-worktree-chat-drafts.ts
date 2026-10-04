import type { AppState } from '../../../types'
import {
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsForTab,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'

/**
 * Deletes the unsent chat drafts of removed worktrees' open tabs: each structured chat's
 * conversation draft and each terminal tab's pane drafts. The tab lists are the only record of
 * which drafts were a worktree's, so whichever removal path drops them first must call this
 * before it does.
 */
export function deleteRemovedWorktreeChatDrafts(
  state: Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  worktreeIds: Iterable<string>
): void {
  for (const worktreeId of worktreeIds) {
    for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
      if (tab.contentType === 'agent-session') {
        deleteNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId))
      }
    }
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      deleteNativeChatComposerDraftsForTab(tab.id)
    }
  }
}

import { useAppStore } from '../store'
import { resolveNativeChatDraftOwner } from '../lib/native-chat-draft-owner'
import {
  hydrateNativeChatComposerDrafts,
  setNativeChatComposerDraftOwnerResolver,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  moveStructuredAgentSessionDraft,
  structuredAgentSessionConversationMoves
} from '@/components/native-chat/structured-agent-session-draft-move'

// A slower load fills drafts not edited meanwhile without holding startup.
const DRAFT_LOAD_WAIT_MS = 1_500

/** Before any startup step, so a step that fails can't leave the drafts unloaded. */
export function startNativeChatDraftLoad(): () => void {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), scopeKey)
  )
  void hydrateNativeChatComposerDrafts()
  return useAppStore.subscribe((state, previous) => {
    if (state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree) {
      return
    }
    for (const { from, to } of structuredAgentSessionConversationMoves(
      previous.unifiedTabsByWorktree,
      state.unifiedTabsByWorktree
    )) {
      moveStructuredAgentSessionDraft(from, to)
    }
  })
}

/** Startup waits alongside the session read, so a composer shows its draft from its first frame. */
export function waitForNativeChatDraftsAtStartup(): Promise<void> {
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}

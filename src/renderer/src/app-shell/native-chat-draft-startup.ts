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

// Why bounded: loading drafts is bookkeeping and must never hold startup; a slower load still
// fills in every draft not edited meanwhile when it lands.
const DRAFT_LOAD_WAIT_MS = 1_500

/** Before any startup step, so a step that fails can't leave the drafts unloaded. */
export function startNativeChatDraftLoad(): () => void {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), scopeKey)
  )
  void hydrateNativeChatComposerDrafts()
  // In the same store update as the tab's move, so the chat's new composer mounts with the draft.
  return useAppStore.subscribe((state, previous) => {
    if (state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree) {
      return
    }
    for (const { from, to } of structuredAgentSessionConversationMoves(
      previous.unifiedTabsByWorktree,
      state.unifiedTabsByWorktree
    )) {
      // Why caught: a draft that fails to move must not fail the tab update that triggered it.
      try {
        moveStructuredAgentSessionDraft(from, to)
      } catch (error) {
        console.warn('[native-chat-drafts] a cleared chat draft could not move', error)
      }
    }
  })
}

/** Startup waits for the drafts alongside the session read, so a composer shows its draft from
 *  its first frame. */
export function waitForNativeChatDraftsAtStartup(): Promise<void> {
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}

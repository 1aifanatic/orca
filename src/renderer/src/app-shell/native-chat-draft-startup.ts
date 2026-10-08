import { useAppStore } from '../store'
import { resolveNativeChatDraftOwner } from '../lib/native-chat-draft-owner'
import {
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  setNativeChatComposerDraftOwnerResolver,
  subscribeToNativeChatComposerDraftLoad,
  structuredAgentSessionDraftScopeKey,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  moveStructuredAgentSessionDraft,
  structuredAgentSessionConversationMoves
} from '@/components/native-chat/structured-agent-session-draft-move'
import { moveNativeChatPendingAttachments } from '@/components/native-chat/native-chat-pending-attachment-cache'

// A slower load fills drafts not edited meanwhile without holding startup.
const DRAFT_LOAD_WAIT_MS = 1_500

/** Before any startup step, so a step that fails can't leave the drafts unloaded. */
export function startNativeChatDraftLoad(): () => void {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), scopeKey)
  )
  const pending = new Map<string, string>()
  const move = (from: string, to: string): void => {
    void moveStructuredAgentSessionDraft(from, to).catch((error) => {
      console.warn('[native-chat-drafts] a cleared chat draft could not move', error)
    })
  }
  const drain = (): void => {
    if (isNativeChatComposerDraftLoadPending()) {
      return
    }
    for (const [from, to] of pending) {
      move(from, to)
    }
    pending.clear()
  }
  const stopLoad = subscribeToNativeChatComposerDraftLoad(drain)
  void hydrateNativeChatComposerDrafts()
  const stopTabs = useAppStore.subscribe((state, previous) => {
    if (state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree) {
      return
    }
    for (const { from, to } of structuredAgentSessionConversationMoves(
      previous.unifiedTabsByWorktree,
      state.unifiedTabsByWorktree
    )) {
      moveNativeChatPendingAttachments(
        structuredAgentSessionDraftScopeKey(from),
        structuredAgentSessionDraftScopeKey(to)
      )
      if (!isNativeChatComposerDraftLoadPending()) {
        move(from, to)
        continue
      }
      // Only observed moves wait for the bounded load; never infer ownership from old clear markers.
      for (const [source, destination] of pending) {
        if (destination === from) {
          pending.set(source, to)
        }
      }
      pending.set(from, to)
    }
  })
  return () => {
    stopLoad()
    pending.clear()
    stopTabs()
  }
}

/** Startup waits alongside the session read, so a composer shows its draft from its first frame. */
export function waitForNativeChatDraftsAtStartup(): Promise<void> {
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}

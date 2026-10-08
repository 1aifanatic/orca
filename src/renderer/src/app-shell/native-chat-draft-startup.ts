import { useAppStore } from '../store'
import { subscribeInitialHostSessionTabs } from '../runtime/initial-host-session-tabs-events'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { resolveNativeChatDraftOwner } from '../lib/native-chat-draft-owner'
import {
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  setNativeChatComposerDraftOwnerResolver,
  subscribeToNativeChatComposerDraftLoad,
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
  const pending = new Map<string, RuntimeMobileSessionTabsResult>()
  const restorePending = (): void => {
    if (isNativeChatComposerDraftLoadPending()) {
      return
    }
    for (const snapshot of pending.values()) {
      const tabs = useAppStore.getState().unifiedTabsByWorktree[snapshot.worktree] ?? []
      const published = new Set(
        snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.sessionId)
      )
      for (const tab of snapshot.tabs) {
        if (
          tab.type === 'agent-session' &&
          tab.replacesSessionId &&
          !published.has(tab.replacesSessionId) &&
          tabs.some(
            (shown) => shown.contentType === 'agent-session' && shown.entityId === tab.sessionId
          )
        ) {
          void moveStructuredAgentSessionDraft(tab.replacesSessionId, tab.sessionId).catch(
            (error) => {
              console.warn('[native-chat-drafts] a restored chat draft could not move', error)
            }
          )
        }
      }
    }
    pending.clear()
  }
  const stopLoad = subscribeToNativeChatComposerDraftLoad(restorePending)
  const stopHost = subscribeInitialHostSessionTabs((snapshot, environmentId) => {
    // Retained only until this bounded load finishes; a later run re-derives from its host.
    pending.set(`${environmentId}:${snapshot.worktree}`, snapshot)
    restorePending()
  })
  void hydrateNativeChatComposerDrafts()
  // In the same store update as the tab's move, so the chat's new composer mounts with the draft.
  const stopTabs = useAppStore.subscribe((state, previous) => {
    if (state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree) {
      return
    }
    for (const { from, to } of structuredAgentSessionConversationMoves(
      previous.unifiedTabsByWorktree,
      state.unifiedTabsByWorktree
    )) {
      // Why caught: a draft that fails to move must not fail the tab update that triggered it.
      void moveStructuredAgentSessionDraft(from, to).catch((error) => {
        console.warn('[native-chat-drafts] a cleared chat draft could not move', error)
      })
    }
  })
  return () => {
    stopLoad()
    stopHost()
    pending.clear()
    stopTabs()
  }
}

/** Startup waits for the drafts alongside the session read, so a composer shows its draft from
 *  its first frame. */
export function waitForNativeChatDraftsAtStartup(): Promise<void> {
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}

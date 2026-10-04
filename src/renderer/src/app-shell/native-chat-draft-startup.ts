import { useAppStore } from '../store'
import { resolveNativeChatDraftOwner } from '../lib/native-chat-draft-owner'
import {
  setNativeChatComposerDraftOwnerResolver,
  waitForNativeChatComposerDrafts
} from '@/components/native-chat/native-chat-composer-draft-store'

// Why bounded: loading drafts is bookkeeping and must never hold startup; a slower load still
// fills in every draft not edited meanwhile when it lands.
const DRAFT_LOAD_WAIT_MS = 1_500

/** Startup waits for the drafts alongside the session read, so a composer shows its draft from
 *  its first frame. */
export function loadNativeChatDraftsForStartup(): Promise<void> {
  setNativeChatComposerDraftOwnerResolver((scopeKey) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), scopeKey)
  )
  return waitForNativeChatComposerDrafts(DRAFT_LOAD_WAIT_MS)
}

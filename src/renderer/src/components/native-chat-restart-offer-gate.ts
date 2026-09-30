import { useAppStore } from '../store'
import { getStructuredAgentSessionTabs } from './native-chat/structured-agent-session-tabs'

/**
 * Whether this window offers to carry on its chats: wherever structured chats exist, since the
 * chat setting picks only what new agents open as. Without either, a machine that never used
 * structured chat builds no host to answer an empty offer.
 */
export function useNativeChatRestartOfferEnabled(): boolean {
  return useAppStore(
    (store) =>
      store.settings?.experimentalStructuredNativeChat === true ||
      getStructuredAgentSessionTabs(store.unifiedTabsByWorktree).length > 0
  )
}

import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatTabScope } from './native-chat-tab-scope'

export function useNativeChatFileLinkContext(scope: NativeChatTabScope) {
  return useAppStore(useShallow((state) => resolveNativeChatFileLinkContext(state, scope)))
}

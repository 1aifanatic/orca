// The composer-restore seam the structured session writes withdrawn queued text
// through. Text is owed by composer scope rather than handed to a live
// composer, so an answer that arrives after the session screen closed still
// lands once that pane's composer is next active.

import { useMemo } from 'react'
import { oweComposerText } from './mobile-native-chat-owed-composer-text'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import type { MobileQueuedComposerRestoreSeam } from './use-mobile-structured-queued-message-controls'

export function useMobileNativeChatQueuedComposerRestore(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
}): MobileQueuedComposerRestoreSeam {
  const draftKey = mobileNativeChatScopeKey(args.hostId, args.worktreeId, args.tabId)
  return useMemo<MobileQueuedComposerRestoreSeam>(
    () => ({ readDraftKey: () => draftKey, appendText: oweComposerText }),
    [draftKey]
  )
}

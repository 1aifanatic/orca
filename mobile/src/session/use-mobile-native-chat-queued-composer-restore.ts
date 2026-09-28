// Bridges the structured session's queued-draft restoration to the composer the
// drafts hook owns. Hook order in the controller is fixed — the session mounts
// before the drafts hook — so the writer is seated through a ref once the drafts
// hook has committed, and restoration is keyed by draft scope so a tab switch
// mid-restore cannot land text in another pane's composer.

import { useCallback, useMemo, useRef } from 'react'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import type { MobileQueuedComposerRestoreSeam } from './use-mobile-structured-queued-message-controls'

type AppendDraftText = (draftKey: string, text: string) => void

export function useMobileNativeChatQueuedComposerRestore(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
}): {
  composerRestore: MobileQueuedComposerRestoreSeam
  /** Seat the drafts hook's keyed append once it exists. */
  seatAppendDraftText: (append: AppendDraftText) => void
} {
  const draftKey = mobileNativeChatScopeKey(args.hostId, args.worktreeId, args.tabId)
  const appendDraftTextRef = useRef<AppendDraftText>(() => {})
  const seatAppendDraftText = useCallback((append: AppendDraftText) => {
    appendDraftTextRef.current = append
  }, [])
  const composerRestore = useMemo<MobileQueuedComposerRestoreSeam>(
    () => ({
      readDraftKey: () => draftKey,
      appendText: (key, text) => appendDraftTextRef.current(key, text)
    }),
    [draftKey]
  )
  return { composerRestore, seatAppendDraftText }
}

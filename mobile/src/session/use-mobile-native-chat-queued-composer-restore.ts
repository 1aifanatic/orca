// Bridges the structured session's queued-draft restoration to the composer the
// drafts hook owns. Hook order in the controller is fixed — the session mounts
// before the drafts hook — so the seam reads through refs seated once the
// drafts hook has rendered, and restoration is keyed by draft scope so a tab
// switch mid-restore cannot land text in another pane's composer.

import { useMemo, useRef } from 'react'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import type { MobileQueuedComposerRestoreSeam } from './use-mobile-structured-queued-message-controls'

export function useMobileNativeChatQueuedComposerRestore(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
}): {
  composerRestore: MobileQueuedComposerRestoreSeam
  /** Seat the drafts hook's keyed append once it exists. */
  seatAppendDraftText: (append: (draftKey: string, text: string) => void) => void
} {
  const activeDraftKeyRef = useRef<string | null>(null)
  activeDraftKeyRef.current = mobileNativeChatScopeKey(args.hostId, args.worktreeId, args.tabId)
  const appendDraftTextRef = useRef<(draftKey: string, text: string) => void>(() => {})
  const seatRef = useRef<(append: (draftKey: string, text: string) => void) => void>((append) => {
    appendDraftTextRef.current = append
  })
  return useMemo(
    () => ({
      composerRestore: {
        readDraftKey: () => activeDraftKeyRef.current,
        appendText: (draftKey: string, text: string) => appendDraftTextRef.current(draftKey, text)
      },
      seatAppendDraftText: (append) => seatRef.current(append)
    }),
    []
  )
}

import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'

/**
 * The pending-chip controls an upload drives. A prompt card unmounts the composer; an upload that
 * finishes meanwhile lands in the scope's attachment and draft caches, which the composer reads
 * back when it returns, instead of in the unmounted one's state.
 */
export function useNativeChatPendingAttachmentChips(args: {
  scopeKey: string
  /** Chips the user has not removed. */
  livePendingChipIds: RefObject<Set<string>>
  begin: NativeChatPendingAttachmentChips['begin']
  resolve: NativeChatPendingAttachmentChips['resolve']
  drop: NativeChatPendingAttachmentChips['drop']
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
}): NativeChatPendingAttachmentChips {
  const { scopeKey, livePendingChipIds, begin, resolve, drop, attachResolvedPaths } = args
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  return useMemo(
    () => ({
      begin,
      resolve: (id, path, connectionId) => {
        if (mountedRef.current) {
          resolve(id, path, connectionId)
        } else if (livePendingChipIds.current.delete(id)) {
          appendNativeChatAttachmentCache(scopeKey, [
            { id, path, ...(connectionId ? { connectionId } : {}) }
          ])
        }
      },
      drop,
      attachReferences: (paths) => {
        if (mountedRef.current) {
          attachResolvedPaths(paths, null)
        } else {
          appendNativeChatDraftCache(scopeKey, paths.map(formatNativeChatFileReference).join(' '))
        }
      }
    }),
    [attachResolvedPaths, begin, drop, livePendingChipIds, resolve, scopeKey]
  )
}

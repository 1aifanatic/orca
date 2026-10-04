import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject
} from 'react'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'
import { nativeChatLocalAttachmentUnsupportedNotice } from './native-chat-attachment-upload'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import {
  dropNativeChatPendingAttachment,
  nativeChatAttachmentSnapshot,
  resolveNativeChatPendingAttachment,
  revealNativeChatPendingAttachment,
  subscribeToNativeChatAttachmentCache,
  updateNativeChatAttachmentCache
} from './native-chat-attachment-cache'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'

export {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './native-chat-attachment-cache'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<NativeChatComposerInput | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  allowWithoutTarget = false,
  caret,
  disabled,
  isComposing,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: NativeChatComposerImageAttachment[]
  attachResolvedPaths: (
    paths: string[],
    connectionId?: string | null,
    options?: NativeChatResolvedPathOptions
  ) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
  beginPendingImageAttachment: (
    previewUrl?: string,
    pendingName?: string,
    options?: { hidden?: true }
  ) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  revealPendingImageAttachment: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => boolean
  pendingChips: NativeChatPendingAttachmentChips
} {
  // The chips live in the scope cache, so a composer a prompt card unmounted comes back to the same
  // ones, still pending where their save or upload is (`native-chat-attachment-cache.ts`).
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatAttachmentCache(attachmentScopeKey, listener),
    [attachmentScopeKey]
  )
  const cached = useSyncExternalStore(subscribe, () =>
    nativeChatAttachmentSnapshot(attachmentScopeKey)
  )
  // Clipboard thumbnails stay with the composer that made them; the cache never holds them.
  const previews = useRef(new Map<string, string>())
  const imageAttachments = useMemo(
    () =>
      cached.map((attachment) => {
        const previewUrl = previews.current.get(attachment.id)
        return previewUrl ? { ...attachment, previewUrl } : attachment
      }),
    [cached]
  )
  const imageAttachmentCounter = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateImageAttachments = useCallback(
    (
      updater: (
        previous: readonly NativeChatComposerImageAttachment[]
      ) => readonly NativeChatComposerImageAttachment[]
    ) => updateNativeChatAttachmentCache(attachmentScopeKey, updater),
    [attachmentScopeKey]
  )

  const releasePreview = useCallback((id: string) => {
    const previewUrl = previews.current.get(id)
    previews.current.delete(id)
    if (previewUrl?.startsWith('blob:')) {
      // Object URLs minted from a clipboard blob leak until revoked; data URLs don't.
      URL.revokeObjectURL(previewUrl)
    }
  }, [])

  const nextAttachmentId = useCallback((): string => {
    imageAttachmentCounter.current += 1
    return `${Date.now()}-${imageAttachmentCounter.current}`
  }, [])

  // Client-local paths cannot cross into a runtime target; workspace-owned
  // paths may only bypass this after the internal drop ownership gate.
  const attachmentTargetBlocked = useCallback(
    (targetOwned = false): boolean => {
      const target = resolveTarget()
      return (
        (!target && !allowWithoutTarget) ||
        Boolean(target && nativeChatComposerTargetIsRemote(target.ptyId) && !targetOwned)
      )
    },
    [allowWithoutTarget, resolveTarget]
  )

  const noteAttachmentTargetBlocked = useCallback(() => {
    setNotice(nativeChatLocalAttachmentUnsupportedNotice())
  }, [setNotice])

  const appendImageAttachments = useCallback(
    (paths: { path: string; connectionId?: string | null }[]) => {
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map(({ path, connectionId }) => ({
          id: nextAttachmentId(),
          path,
          connectionId: connectionId ?? undefined
        }))
      ])
    },
    [nextAttachmentId, updateImageAttachments]
  )

  const { attachResolvedPaths, disabledRef, flushPendingAttachments } =
    useNativeChatResolvedPathAttachments({
      appendImageAttachments,
      attachmentTargetBlocked,
      caret,
      disabled,
      isComposing,
      noteAttachmentTargetBlocked,
      setCaret,
      setDraft,
      setNotice,
      textareaRef
    })

  // Placeholder chip shown the instant a paste starts, so a clipboard image that
  // takes a beat to save (or upload over SSH) never reads as a dropped paste.
  const beginPendingImageAttachment = useCallback(
    (previewUrl?: string, pendingName?: string, options?: { hidden?: true }): string | null => {
      if (disabledRef.current) {
        return null
      }
      if (attachmentTargetBlocked()) {
        noteAttachmentTargetBlocked()
        return null
      }
      const id = nextAttachmentId()
      if (previewUrl) {
        previews.current.set(id, previewUrl)
      }
      updateImageAttachments((prev) => [
        ...prev,
        {
          id,
          path: '',
          pending: true,
          ...(pendingName ? { pendingName } : {}),
          ...(options?.hidden ? { hidden: true } : {})
        }
      ])
      return id
    },
    [
      attachmentTargetBlocked,
      disabledRef,
      nextAttachmentId,
      noteAttachmentTargetBlocked,
      updateImageAttachments
    ]
  )

  const resolvePendingImageAttachment = useCallback(
    (id: string, path: string, connectionId?: string | null) => {
      resolveNativeChatPendingAttachment(attachmentScopeKey, id, path, connectionId)
    },
    [attachmentScopeKey]
  )

  const revealPendingImageAttachment = useCallback(
    (id: string, previewUrl?: string) => {
      if (previewUrl) {
        previews.current.set(id, previewUrl)
      }
      revealNativeChatPendingAttachment(attachmentScopeKey, id)
    },
    [attachmentScopeKey]
  )

  const dropPendingImageAttachment = useCallback(
    (id: string): boolean => {
      releasePreview(id)
      return dropNativeChatPendingAttachment(attachmentScopeKey, id)
    },
    [attachmentScopeKey, releasePreview]
  )

  const pendingChips = useMemo(
    (): NativeChatPendingAttachmentChips => ({
      begin: beginPendingImageAttachment,
      resolve: resolvePendingImageAttachment,
      drop: dropPendingImageAttachment,
      // At the caret, as every attach does; mid-composition or once the composer is gone, into the
      // scope's draft, which keeps it until the composition settles or the composer comes back.
      attachReferences: (paths) => {
        if (mountedRef.current && !isComposing()) {
          attachResolvedPaths(paths, null)
          return
        }
        appendNativeChatDraftCache(
          attachmentScopeKey,
          paths.map(formatNativeChatFileReference).join(' ')
        )
      }
    }),
    [
      attachResolvedPaths,
      attachmentScopeKey,
      beginPendingImageAttachment,
      dropPendingImageAttachment,
      isComposing,
      resolvePendingImageAttachment
    ]
  )

  return {
    pendingChips,
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () => {
      ;[...previews.current.keys()].forEach(releasePreview)
      updateImageAttachments(() => [])
    },
    flushPendingAttachments,
    removeImageAttachment: (id) => {
      releasePreview(id)
      updateImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
    },
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    revealPendingImageAttachment,
    dropPendingImageAttachment
  }
}

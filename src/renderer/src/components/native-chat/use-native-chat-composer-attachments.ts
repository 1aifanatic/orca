import type { NativeChatComposerInput } from './native-chat-composer-input'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from 'react'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  isKeptLocalPaste,
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { useRestoredNativeChatComposerDraftImageCheck } from './native-chat-composer-draft-image-check'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'
import { nativeChatLocalAttachmentUnsupportedNotice } from './native-chat-attachment-upload'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachments,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  revealNativeChatPendingAttachment,
  subscribeToNativeChatPendingAttachments,
  takeNativeChatPendingAttachment
} from './native-chat-pending-attachment-cache'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'

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
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(attachmentScopeKey, listener),
    [attachmentScopeKey]
  )
  const settled = useSyncExternalStore(
    subscribe,
    () => readNativeChatComposerDraft(attachmentScopeKey).images
  )
  // Why: a restored paste shows only once main confirms it is still kept, so until the restore
  // check is done it waits like a chip still saving, instead of flashing before a placeholder.
  const restoring = useRestoredNativeChatComposerDraftImageCheck(attachmentScopeKey, subscribe)
  // Chips still on their way live outside the composer, so one a prompt card unmounted comes back
  // still pending and settles into the draft whichever composer is showing.
  const subscribePending = useCallback(
    (listener: () => void) => subscribeToNativeChatPendingAttachments(attachmentScopeKey, listener),
    [attachmentScopeKey]
  )
  const pending = useSyncExternalStore(subscribePending, () =>
    nativeChatPendingAttachmentSnapshot(attachmentScopeKey)
  )
  // The clipboard previews this composer minted are its own; no store holds them.
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(NO_PREVIEWS)
  // Read by callbacks between renders; only they change it, always together with the state.
  const previewsRef = useRef(previews)
  const updatePreviews = useCallback((next: ReadonlyMap<string, string>) => {
    previewsRef.current = next
    setPreviews(next)
  }, [])
  const imageAttachments = useMemo(
    () => [
      ...settled.map((image) => {
        const previewUrl = previews.get(image.id)
        if (restoring && isKeptLocalPaste(image)) {
          return { ...image, pending: true }
        }
        return previewUrl ? { ...image, previewUrl } : image
      }),
      ...pending.map((chip) => {
        const previewUrl = previews.get(chip.id)
        return previewUrl ? { ...chip, previewUrl } : chip
      })
    ],
    [pending, previews, restoring, settled]
  )
  // A preview whose image left the draft (sent, or removed elsewhere) is released.
  useEffect(() => {
    const current = previewsRef.current
    const gone = [...current.keys()].filter(
      (id) => !settled.some((image) => image.id === id) && !pending.some((chip) => chip.id === id)
    )
    if (gone.length === 0) {
      return
    }
    const next = new Map(current)
    for (const id of gone) {
      releasePreviewUrl(next.get(id))
      next.delete(id)
    }
    updatePreviews(next)
  }, [pending, settled, updatePreviews])
  const imageAttachmentCounter = useRef(0)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setPreview = useCallback(
    (id: string, previewUrl: string | undefined) => {
      if (previewUrl) {
        updatePreviews(new Map(previewsRef.current).set(id, previewUrl))
      }
    },
    [updatePreviews]
  )

  const releasePreview = useCallback(
    (id: string) => {
      const current = previewsRef.current
      if (!current.has(id)) {
        return
      }
      releasePreviewUrl(current.get(id))
      const next = new Map(current)
      next.delete(id)
      updatePreviews(next)
    },
    [updatePreviews]
  )

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
      appendNativeChatAttachmentCache(
        attachmentScopeKey,
        paths.map(({ path, connectionId }) => ({
          id: nextAttachmentId(),
          path,
          ...(connectionId ? { connectionId } : {})
        })),
        { fromUser: true }
      )
    },
    [attachmentScopeKey, nextAttachmentId]
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
      addNativeChatPendingAttachment(attachmentScopeKey, {
        id,
        path: '',
        pending: true,
        ...(pendingName ? { pendingName } : {}),
        ...(options?.hidden ? { hidden: true } : {})
      })
      setPreview(id, previewUrl)
      return id
    },
    [
      attachmentScopeKey,
      attachmentTargetBlocked,
      disabledRef,
      nextAttachmentId,
      noteAttachmentTargetBlocked,
      setPreview
    ]
  )

  const resolvePendingImageAttachment = useCallback(
    (id: string, path: string, connectionId?: string | null) => {
      settleNativeChatPendingAttachment(attachmentScopeKey, id, path, connectionId)
    },
    [attachmentScopeKey]
  )

  const revealPendingImageAttachment = useCallback(
    (id: string, previewUrl?: string) => {
      setPreview(id, previewUrl)
      revealNativeChatPendingAttachment(attachmentScopeKey, id)
    },
    [attachmentScopeKey, setPreview]
  )

  // A pending chip was never saved, so dropping one, even late from a replaced composer, leaves
  // the draft alone.
  const dropPendingImageAttachment = useCallback(
    (id: string): boolean => {
      releasePreview(id)
      return takeNativeChatPendingAttachment(attachmentScopeKey, id) !== undefined
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
      previewsRef.current.forEach(releasePreviewUrl)
      updatePreviews(NO_PREVIEWS)
      clearNativeChatPendingAttachments(attachmentScopeKey)
      updateNativeChatComposerDraft(attachmentScopeKey, { images: [] }, 'immediate')
    },
    flushPendingAttachments,
    removeImageAttachment: (id) => {
      releasePreview(id)
      // A chip still on its way is removed before it settles, so its file never joins the message.
      if (takeNativeChatPendingAttachment(attachmentScopeKey, id)) {
        return
      }
      const images = readNativeChatComposerDraft(attachmentScopeKey).images
      updateNativeChatComposerDraft(
        attachmentScopeKey,
        { images: images.filter((image) => image.id !== id) },
        'immediate'
      )
    },
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    revealPendingImageAttachment,
    dropPendingImageAttachment
  }
}

const NO_PREVIEWS: ReadonlyMap<string, string> = new Map()

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releasePreviewUrl(previewUrl: string | undefined): void {
  if (previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(previewUrl)
  }
}

/** Settles a pending chip into the scope's draft. False when the user already removed it. */
export function settleNativeChatPendingAttachment(
  scopeKey: string,
  id: string,
  path: string,
  connectionId?: string | null
): boolean {
  if (!takeNativeChatPendingAttachment(scopeKey, id)) {
    return false
  }
  appendNativeChatAttachmentCache(
    scopeKey,
    [{ id, path, ...(connectionId ? { connectionId } : {}) }],
    { fromUser: true }
  )
  return true
}

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return readNativeChatComposerDraft(scopeKey).images.map((image) => ({ ...image }))
}

/** Adds settled images after the ones the draft holds now, durably at once: when Stop gives images
 *  back, the copy they came from goes right after this. Only an image the user attaches
 *  (`fromUser`) takes the place of a placeholder with its file name, as a re-pick does. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): void {
  if (appended.length === 0) {
    return
  }
  // Preview URLs can retain the full clipboard Blob, so only the path is kept.
  appendToNativeChatComposerDraft(scopeKey, {
    images: appended.map(({ id, path, connectionId }) => ({
      id,
      path,
      ...(connectionId ? { connectionId } : {})
    })),
    ...(options?.fromUser ? { fromUser: true } : {})
  })
}

export function clearNativeChatAttachmentCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachmentsForTests()
}

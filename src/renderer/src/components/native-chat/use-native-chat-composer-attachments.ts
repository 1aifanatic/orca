import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { useNativeChatResolvedPathAttachments } from './use-native-chat-resolved-path-attachments'

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
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  dropPendingImageAttachment: (id: string) => void
} {
  const [imageAttachments, setImageAttachments] = useState<NativeChatComposerImageAttachment[]>(
    () => readNativeChatAttachmentCache(attachmentScopeKey)
  )
  // The chips shown, so each change is computed and saved where it happens, not in a state updater.
  const imageAttachmentsRef = useRef(imageAttachments)
  useLayoutEffect(() => {
    imageAttachmentsRef.current = imageAttachments
  }, [imageAttachments])
  const imageAttachmentCounter = useRef(0)

  useEffect(
    () =>
      subscribeToNativeChatAttachmentAppend(attachmentScopeKey, (appended) => {
        imageAttachmentsRef.current = [...imageAttachmentsRef.current, ...appended]
        setImageAttachments(imageAttachmentsRef.current)
      }),
    [attachmentScopeKey]
  )

  const updateImageAttachments = useCallback(
    (
      updater: (
        previous: NativeChatComposerImageAttachment[]
      ) => NativeChatComposerImageAttachment[],
      save = true
    ) => {
      const next = updater(imageAttachmentsRef.current)
      imageAttachmentsRef.current = next
      setImageAttachments(next)
      if (save) {
        writeNativeChatAttachmentCache(attachmentScopeKey, next)
      }
    },
    [attachmentScopeKey]
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
    setNotice(
      translate(
        'components.native-chat.composer.localAttachmentUnsupported',
        'Local attachments are not available for remote sessions.'
      )
    )
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
    (previewUrl?: string): string | null => {
      if (disabledRef.current) {
        return null
      }
      if (attachmentTargetBlocked()) {
        noteAttachmentTargetBlocked()
        return null
      }
      const id = nextAttachmentId()
      updateImageAttachments((prev) => [...prev, { id, path: '', previewUrl, pending: true }])
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
      updateImageAttachments((prev) =>
        prev.map((attachment) =>
          attachment.id === id
            ? {
                ...attachment,
                path,
                connectionId: connectionId ?? undefined,
                pending: undefined
              }
            : attachment
        )
      )
    },
    [updateImageAttachments]
  )

  const dropPendingImageAttachment = useCallback(
    (id: string) => {
      // Why no save: a pending chip was never saved, and a late drop from an unmounted composer
      // would write its stale chips over what a newer composer sent.
      updateImageAttachments((prev) => removeAttachmentById(prev, id), false)
    },
    [updateImageAttachments]
  )

  return {
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () =>
      updateImageAttachments((prev) => {
        prev.forEach(releaseAttachmentPreview)
        return []
      }),
    flushPendingAttachments,
    removeImageAttachment: (id) => updateImageAttachments((prev) => removeAttachmentById(prev, id)),
    beginPendingImageAttachment,
    resolvePendingImageAttachment,
    dropPendingImageAttachment
  }
}

/** Object URLs minted from a clipboard blob leak until revoked; data URLs don't. */
function releaseAttachmentPreview(attachment: NativeChatComposerImageAttachment): void {
  if (attachment.previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

function removeAttachmentById(
  attachments: readonly NativeChatComposerImageAttachment[],
  id: string
): NativeChatComposerImageAttachment[] {
  const removed = attachments.find((attachment) => attachment.id === id)
  if (removed) {
    releaseAttachmentPreview(removed)
  }
  return attachments.filter((attachment) => attachment.id !== id)
}

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return readNativeChatComposerDraft(scopeKey).images.map((image) => ({ ...image }))
}

function writeNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly NativeChatComposerImageAttachment[]
): void {
  // A pending chip's save resolves into THIS hook instance; restoring one into a
  // remount would strand it pending forever, so only settled chips are kept.
  // Preview URLs can retain the full clipboard Blob (or a large data URL), so
  // never keep the transient preview: settled chips reload from their path.
  updateNativeChatComposerDraft(
    scopeKey,
    {
      images: attachments.flatMap(({ id, path, connectionId, pending }) =>
        pending ? [] : [{ id, path, ...(connectionId ? { connectionId } : {}) }]
      )
    },
    'immediate'
  )
}

// Only a write from outside the composer notifies; its own writes already hold the chips.
const appendListeners = new Map<
  string,
  Set<(appended: readonly NativeChatComposerImageAttachment[]) => void>
>()

/** Puts settled images back after whatever is attached, and shows them in a mounted composer. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[]
): void {
  if (appended.length === 0) {
    return
  }
  // Saved now: the copy it came from goes right after this.
  writeNativeChatAttachmentCache(scopeKey, [
    ...readNativeChatAttachmentCache(scopeKey),
    ...appended
  ])
  appendListeners.get(scopeKey)?.forEach((listener) => listener(appended))
}

function subscribeToNativeChatAttachmentAppend(
  scopeKey: string,
  listener: (appended: readonly NativeChatComposerImageAttachment[]) => void
): () => void {
  const listeners = appendListeners.get(scopeKey) ?? new Set()
  appendListeners.set(scopeKey, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && appendListeners.get(scopeKey) === listeners) {
      appendListeners.delete(scopeKey)
    }
  }
}

export function clearNativeChatAttachmentCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
}

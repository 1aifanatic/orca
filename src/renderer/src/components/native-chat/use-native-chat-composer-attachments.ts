import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  readNativeChatDraftAttachments,
  subscribeToNativeChatDraft,
  writeNativeChatDraftAttachments,
  type NativeChatDraftAttachment
} from './native-chat-draft-cache'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import { findMissingNativeChatAttachments } from './native-chat-attachment-existence'
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
  const [shownAtMount] = useState(() => readNativeChatDraftAttachments(attachmentScopeKey))
  const [imageAttachments, setImageAttachments] = useState<NativeChatComposerImageAttachment[]>(
    () => [...shownAtMount]
  )
  // This view's chips for synchronous updates; React state only renders them.
  const attachmentsRef = useRef(imageAttachments)
  const writerRef = useRef<object>({})
  // The shared list last shown here.
  const syncedRef = useRef<readonly NativeChatDraftAttachment[]>(shownAtMount)
  // Chips this view has checked or attached itself; anything else may be restored from disk.
  const checkedIdsRef = useRef(new Set<string>())
  const [missingIds, setMissingIds] = useState<ReadonlySet<string>>(() => new Set())

  const showAttachments = useCallback((next: NativeChatComposerImageAttachment[]) => {
    attachmentsRef.current = next
    setImageAttachments(next)
  }, [])

  // A saved draft can outlive its image (age sweep, OS temp cleanup), so each restored chip is
  // checked once; a missing one is shown as such and blocks Send, rather than sending a dead path.
  useEffect(() => {
    const unchecked = imageAttachments.filter(
      (attachment) => !attachment.pending && !checkedIdsRef.current.has(attachment.id)
    )
    if (unchecked.length === 0) {
      return
    }
    unchecked.forEach((attachment) => checkedIdsRef.current.add(attachment.id))
    void findMissingNativeChatAttachments(unchecked).then((missing) => {
      if (missing.size > 0) {
        setMissingIds((previous) => new Set([...previous, ...missing]))
      }
    })
  }, [imageAttachments])

  // Settled chips are the chat's, shared with every view; pending chips and previews stay here.
  useEffect(() => {
    const showShared = (writer?: object): void => {
      const shared = readNativeChatDraftAttachments(attachmentScopeKey)
      if (writer === writerRef.current || shared === syncedRef.current) {
        return
      }
      syncedRef.current = shared
      const local = attachmentsRef.current
      const sharedById = new Map(shared.map((attachment) => [attachment.id, attachment]))
      // Chips keep the order they were added in, pending ones included; new ones go last.
      const kept = local.flatMap((attachment) => {
        const settled = sharedById.get(attachment.id)
        if (attachment.pending) {
          return [attachment]
        }
        if (!settled) {
          releaseAttachmentPreview(attachment)
          return []
        }
        return [attachment.previewUrl ? { ...settled, previewUrl: attachment.previewUrl } : settled]
      })
      const localIds = new Set(local.map((attachment) => attachment.id))
      showAttachments([...kept, ...shared.filter((attachment) => !localIds.has(attachment.id))])
    }
    const unsubscribe = subscribeToNativeChatDraft(attachmentScopeKey, showShared)
    // A write between this view's render and its subscription would otherwise never show here.
    showShared()
    return unsubscribe
  }, [attachmentScopeKey, showAttachments])

  const updateImageAttachments = useCallback(
    (
      updater: (
        previous: NativeChatComposerImageAttachment[]
      ) => NativeChatComposerImageAttachment[]
    ) => {
      const next = updater(attachmentsRef.current)
      showAttachments(next)
      writeNativeChatAttachmentCache(attachmentScopeKey, next, writerRef.current)
      syncedRef.current = readNativeChatDraftAttachments(attachmentScopeKey)
    },
    [attachmentScopeKey, showAttachments]
  )

  // Every view of the chat attaches into one list, so ids must not repeat across views.
  const nextAttachmentId = useCallback((): string => createBrowserUuid(), [])

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
      const attached = paths.map(({ path, connectionId }) => ({
        id: nextAttachmentId(),
        path,
        connectionId: connectionId ?? undefined
      }))
      attached.forEach(({ id }) => checkedIdsRef.current.add(id))
      updateImageAttachments((prev) => [...prev, ...attached])
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
      checkedIdsRef.current.add(id)
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
      updateImageAttachments((prev) => removeAttachmentById(prev, id))
    },
    [updateImageAttachments]
  )

  const shownAttachments = useMemo(
    () =>
      missingIds.size === 0
        ? imageAttachments
        : imageAttachments.map((attachment) =>
            missingIds.has(attachment.id) ? { ...attachment, missing: true } : attachment
          ),
    [imageAttachments, missingIds]
  )

  return {
    imageAttachments: shownAttachments,
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

function writeNativeChatAttachmentCache(
  scopeKey: string,
  cacheable: readonly NativeChatComposerImageAttachment[],
  writer: object
): void {
  // A pending chip's save resolves into THIS hook instance; sharing one with another view or a
  // remount would strand it pending forever, so only settled chips are written.
  // Preview URLs can retain the full clipboard Blob (or a large data URL); settled
  // attachments reload from their path, which Orca's attachment roots keep readable.
  writeNativeChatDraftAttachments(
    scopeKey,
    cacheable
      .filter((attachment) => !attachment.pending)
      .map(
        ({ previewUrl: _previewUrl, pending: _pending, missing: _missing, ...attachment }) =>
          attachment
      ),
    writer
  )
}

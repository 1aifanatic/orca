import type { NativeChatComposerInput } from './native-chat-composer-input'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
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
    () => [...readNativeChatDraftAttachments(attachmentScopeKey)]
  )
  // This view's chips for synchronous updates; React state only renders them.
  const attachmentsRef = useRef(imageAttachments)
  const writerRef = useRef<object>({})
  // The shared list last shown here; null until the first sync.
  const syncedRef = useRef<readonly NativeChatDraftAttachment[] | null>(null)
  const imageAttachmentCounter = useRef(0)

  const showAttachments = useCallback((next: NativeChatComposerImageAttachment[]) => {
    attachmentsRef.current = next
    setImageAttachments(next)
  }, [])

  // Settled chips are the chat's, shared with every view; pending chips and previews stay here.
  useEffect(
    () =>
      subscribeToNativeChatDraft(attachmentScopeKey, (writer) => {
        const shared = readNativeChatDraftAttachments(attachmentScopeKey)
        if (writer === writerRef.current || shared === syncedRef.current) {
          return
        }
        syncedRef.current = shared
        const local = attachmentsRef.current
        const sharedIds = new Set(shared.map((attachment) => attachment.id))
        local
          .filter((attachment) => !attachment.pending && !sharedIds.has(attachment.id))
          .forEach(releaseAttachmentPreview)
        const previews = new Map(
          local.flatMap((attachment) =>
            attachment.previewUrl ? [[attachment.id, attachment.previewUrl] as const] : []
          )
        )
        showAttachments([
          ...shared.map((attachment) => {
            const previewUrl = previews.get(attachment.id)
            return previewUrl ? { ...attachment, previewUrl } : attachment
          }),
          ...local.filter((attachment) => attachment.pending)
        ])
      }),
    [attachmentScopeKey, showAttachments]
  )

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
      updateImageAttachments((prev) => removeAttachmentById(prev, id))
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

function writeNativeChatAttachmentCache(
  scopeKey: string,
  cacheable: readonly NativeChatComposerImageAttachment[],
  writer: object
): void {
  // A pending chip's save resolves into THIS hook instance; sharing one with another view or a
  // remount would strand it pending forever, so only settled chips are written.
  // Preview URLs can retain the full clipboard Blob (or a large data URL); settled
  // attachments reload from their authorized path after a remount.
  writeNativeChatDraftAttachments(
    scopeKey,
    cacheable
      .filter((attachment) => !attachment.pending)
      .map(({ previewUrl: _previewUrl, pending: _pending, ...attachment }) => attachment),
    writer
  )
}

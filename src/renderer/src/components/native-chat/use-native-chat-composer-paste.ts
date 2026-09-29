import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { nativeChatAttachmentOwnerUnchanged } from './native-chat-resolved-path-ownership'
import { assertClipboardTextWithinLimit } from '../../../../shared/clipboard-text'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import type { AgentType } from '../../../../shared/agent-status-types'
import { NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES } from './native-chat-composer-target'
import {
  nativeChatLocalAttachmentUnsupportedNotice,
  nativeChatWorktreeNotReadyNotice,
  type NativeChatAttachmentOwner
} from './native-chat-attachment-upload'

export type UseNativeChatComposerPasteArgs = {
  targetKey?: string
  agent: AgentType
  /** Live composer-disabled state (no pty / presence-lock); read at await-resume
   *  via a ref so a flip mid-paste doesn't write into a guarded composer. */
  disabled: boolean
  caret: number
  /** Resolved at paste time: SSH panes must save the clipboard image on the
   *  remote host, or the attached path names a file the agent cannot read. */
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  dropPendingImageAttachment: (id: string) => void
  insertTypedText: (text: string) => boolean
  setCaret: (caret: number) => void
  setNotice: (notice: string | null) => void
}

/** Minimal shape shared by React's synthetic ClipboardEvent and the native DOM
 *  ClipboardEvent — the pane-level listener delivers the native one. */
type ClipboardEventLike = {
  clipboardData: DataTransfer | null
  preventDefault: () => void
  defaultPrevented: boolean
}

function clipboardEventImageFile(event: ClipboardEventLike): File | null {
  const data = event.clipboardData
  if (!data) {
    return null
  }
  const item = Array.from(data.items).find((candidate) => candidate.type.startsWith('image/'))
  return item?.getAsFile() ?? null
}

/** Owners whose attachment path is a file this client can write right now. */
function ownerAcceptsClipboardImage(
  owner: NativeChatAttachmentOwner
): owner is Extract<NativeChatAttachmentOwner, { kind: 'local' | 'ssh' }> {
  return owner.kind === 'local' || owner.kind === 'ssh'
}

function ownerConnectionId(owner: NativeChatAttachmentOwner): string | null {
  return owner.kind === 'ssh' ? owner.connectionId : null
}

export function useNativeChatComposerPaste({
  targetKey,
  disabled,
  caret,
  resolveAttachmentOwner,
  attachResolvedPaths,
  beginPendingImageAttachment,
  resolvePendingImageAttachment,
  dropPendingImageAttachment,
  insertTypedText,
  setCaret,
  setNotice
}: UseNativeChatComposerPasteArgs): {
  handlePaste: (event: ClipboardEventLike) => void
  pasteFromClipboard: () => void
} {
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const insertTextRef = useRef(insertTypedText)
  insertTextRef.current = insertTypedText
  const dropPendingRef = useRef(dropPendingImageAttachment)
  dropPendingRef.current = dropPendingImageAttachment
  const lifetime = useMemo(
    () => ({ targetKey, active: false, pending: new Map<string, string>() }),
    [targetKey]
  )
  useLayoutEffect(() => {
    lifetime.active = true
    return () => {
      lifetime.active = false
      for (const [id, preview] of lifetime.pending) {
        if (preview.startsWith('blob:')) {
          URL.revokeObjectURL(preview)
        }
        dropPendingRef.current(id)
      }
      lifetime.pending.clear()
    }
  }, [lifetime])
  const canPaste = useCallback(() => lifetime.active && !disabledRef.current, [lifetime])

  // Image failures do not decide whether text can be inserted.
  const saveClipboardImageForOwner = useCallback(
    async (
      owner: NativeChatAttachmentOwner
    ): Promise<{ status: 'saved'; tempPath: string } | { status: 'empty' | 'failed' }> => {
      if (owner.kind === 'runtime') {
        setNotice(nativeChatLocalAttachmentUnsupportedNotice())
        return { status: 'failed' }
      }
      try {
        // SSH panes save the image on the remote host (SFTP) so the attached
        // path is readable by the remote agent, matching terminal image paste.
        const tempPath = await window.api.ui.saveClipboardImageAsTempFile(
          owner.kind === 'ssh' ? { connectionId: owner.connectionId } : undefined
        )
        return tempPath ? { status: 'saved', tempPath } : { status: 'empty' }
      } catch (error) {
        // A failed save must be visible: over SSH it fails whenever the
        // connection drops, and a silent no-op reads as a broken paste.
        if (canPaste()) {
          setNotice(
            extractIpcErrorMessage(
              error,
              translate('components.native-chat.composer.imagePasteFailed', 'Image paste failed.')
            )
          )
        }
        return { status: 'failed' }
      }
    },
    [canPaste, setNotice]
  )

  /** Settle the chip started at paste time, or attach directly when the paste
   *  produced no placeholder (no clipboard preview was available). */
  const settleImagePaste = useCallback(
    (
      pendingId: string | null,
      path: string,
      connectionId: string | null,
      originalOwner: NativeChatAttachmentOwner
    ) => {
      if (!nativeChatAttachmentOwnerUnchanged(originalOwner, resolveAttachmentOwner())) {
        if (pendingId) {
          lifetime.pending.delete(pendingId)
          dropPendingImageAttachment(pendingId)
        }
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      if (pendingId) {
        lifetime.pending.delete(pendingId)
        resolvePendingImageAttachment(pendingId, path, connectionId)
      } else {
        attachResolvedPaths([path], connectionId)
      }
    },
    [
      attachResolvedPaths,
      lifetime,
      dropPendingImageAttachment,
      resolveAttachmentOwner,
      resolvePendingImageAttachment,
      setNotice
    ]
  )

  const handlePaste = useCallback(
    (event: ClipboardEventLike) => {
      // Dedupe: the pane-level capture listener runs first and preventDefaults
      // images, so the textarea's bubble-phase onPaste must not attach again.
      if (event.defaultPrevented) {
        return
      }
      const imageFile = clipboardEventImageFile(event)
      const text = event.clipboardData?.getData('text/plain')
      if (!imageFile && !text) {
        return
      }
      event.preventDefault()
      if (!canPaste()) {
        return
      }
      setNotice(null)
      if (text) {
        try {
          assertClipboardTextWithinLimit(text, { maxBytes: NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES })
          insertTextRef.current(text)
        } catch (error) {
          setNotice(extractIpcErrorMessage(error, 'Paste failed.'))
        }
      }
      if (!imageFile) {
        return
      }
      const owner = resolveAttachmentOwner()
      if (owner.kind === 'not-ready') {
        setNotice(nativeChatWorktreeNotReadyNotice())
        return
      }
      // Why: snapshot the caret before the async temp-file round-trip — `caret`
      // state can move (further typing/selection) while the await is in flight.
      const caretAtPaste = caret
      // The clipboard blob is already in this process, so the chip can show the
      // real image on the same tick the paste happens — no round-trip at all.
      const previewUrl = ownerAcceptsClipboardImage(owner)
        ? URL.createObjectURL(imageFile)
        : undefined
      const pendingId = previewUrl ? beginPendingImageAttachment(previewUrl) : null
      if (previewUrl && !pendingId) {
        URL.revokeObjectURL(previewUrl)
      }
      if (pendingId) {
        lifetime.pending.set(pendingId, previewUrl ?? '')
      }
      void (async () => {
        const saved = await saveClipboardImageForOwner(owner)
        if (saved.status !== 'saved' || !canPaste()) {
          if (pendingId) {
            lifetime.pending.delete(pendingId)
            dropPendingImageAttachment(pendingId)
          }
          return
        }
        settleImagePaste(pendingId, saved.tempPath, ownerConnectionId(owner), owner)
        if (!text) {
          setCaret(caretAtPaste)
        }
      })()
    },
    [
      beginPendingImageAttachment,
      canPaste,
      lifetime,
      caret,
      dropPendingImageAttachment,
      resolveAttachmentOwner,
      saveClipboardImageForOwner,
      setCaret,
      setNotice,
      settleImagePaste
    ]
  )

  const pasteFromClipboard = useCallback(() => {
    if (!canPaste()) {
      return
    }
    setNotice(null)
    // Text belongs to the editor even when the attachment host is unavailable.
    void window.api.ui
      .readClipboardText({ maxBytes: NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES })
      .then((text) => {
        if (text && canPaste()) {
          insertTextRef.current(text)
        }
      })
      .catch((error) => {
        if (canPaste()) {
          setNotice(extractIpcErrorMessage(error, 'Paste failed.'))
        }
      })
    void (async () => {
      const owner = resolveAttachmentOwner()
      if (!ownerAcceptsClipboardImage(owner)) {
        const hasImage = await window.api.ui.clipboardHasImage().catch(() => null)
        if (hasImage && canPaste()) {
          setNotice(
            owner.kind === 'runtime'
              ? nativeChatLocalAttachmentUnsupportedNotice()
              : nativeChatWorktreeNotReadyNotice()
          )
        }
        return
      }
      const thumbnailPromise = window.api.ui.readClipboardImageThumbnail().catch(() => null)
      const savePromise = saveClipboardImageForOwner(owner)
      const thumbnail = await thumbnailPromise
      const pendingId =
        thumbnail && canPaste() ? beginPendingImageAttachment(thumbnail.dataUrl) : null
      if (pendingId) {
        lifetime.pending.set(pendingId, thumbnail?.dataUrl ?? '')
      }
      const saved = await savePromise
      if (!canPaste() || saved.status !== 'saved') {
        if (pendingId) {
          lifetime.pending.delete(pendingId)
          dropPendingImageAttachment(pendingId)
        }
        return
      }
      settleImagePaste(pendingId, saved.tempPath, ownerConnectionId(owner), owner)
    })()
  }, [
    beginPendingImageAttachment,
    canPaste,
    lifetime,
    dropPendingImageAttachment,
    resolveAttachmentOwner,
    saveClipboardImageForOwner,
    setNotice,
    settleImagePaste
  ])

  return { handlePaste, pasteFromClipboard }
}

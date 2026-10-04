import { useCallback } from 'react'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { nativeChatAttachmentOwnerChangedNotice } from './native-chat-attachment-upload'
import {
  nativeChatAttachmentsForeignToDestination,
  readNativeChatHostOwnedReferences,
  stripNativeChatFileReferences
} from './native-chat-attachment-destination'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/**
 * Right before a structured send, every attachment stored on a paired server is checked against
 * where this chat runs now. One stored for another server, pairing or chat is dropped, and the
 * message waits for the user to attach the files again; a reconnect to the same server keeps them.
 */
export function useNativeChatAttachmentSendGuard(args: {
  scopeKey: string
  structuredTransport?: NativeChatStructuredComposerTransport
  draft: string
  setDraft: (value: string) => void
  removeImageAttachment: (id: string) => void
  setNotice: (notice: string | null) => void
  sendStructured: (text: string, attachments: readonly NativeChatComposerImageAttachment[]) => void
}): (text: string, attachments: readonly NativeChatComposerImageAttachment[]) => void {
  const { scopeKey, structuredTransport, draft, setDraft, removeImageAttachment, setNotice } = args
  const { sendStructured } = args
  return useCallback(
    (text, attachments) => {
      const environmentId = structuredTransport?.runtimeEnvironmentId ?? null
      const foreign = nativeChatAttachmentsForeignToDestination({
        chips: attachments,
        references: readNativeChatHostOwnedReferences(scopeKey),
        draft,
        destination:
          environmentId && structuredTransport
            ? {
                environmentId,
                pairingRevision: getRuntimeEnvironmentRevision(environmentId),
                sessionId: structuredTransport.sessionId
              }
            : null
      })
      if (foreign.chipIds.length === 0 && foreign.references.length === 0) {
        sendStructured(text, attachments)
        return
      }
      for (const chipId of foreign.chipIds) {
        removeImageAttachment(chipId)
      }
      if (foreign.references.length > 0) {
        setDraft(stripNativeChatFileReferences(draft, foreign.references))
      }
      setNotice(nativeChatAttachmentOwnerChangedNotice())
    },
    [
      draft,
      removeImageAttachment,
      scopeKey,
      sendStructured,
      setDraft,
      setNotice,
      structuredTransport
    ]
  )
}

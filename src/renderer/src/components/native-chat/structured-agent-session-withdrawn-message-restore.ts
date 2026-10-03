import { useMemo } from 'react'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { appendNativeChatDraftCache, readNativeChatDraftCache } from './native-chat-draft-cache'
import {
  appendNativeChatAttachmentCache,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'

/**
 * Gives the sender back what its own Stop took out of the outbox before the host held it, into
 * an empty composer only: the host never had it, so the transcript cannot show it. Returns whether
 * they went in; a composer holding text or images keeps what is there, and the caller keeps the
 * entries. What the host withdrew stays in the transcript.
 */
function restoreUnsentMessages(
  composerScopeKey: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  if (
    !composerScopeKey ||
    readNativeChatDraftCache(composerScopeKey) !== '' ||
    readNativeChatAttachmentCache(composerScopeKey).length > 0
  ) {
    return false
  }
  for (const entry of withdrawn) {
    const blocks = entry.body.blocks
    appendNativeChatDraftCache(
      composerScopeKey,
      blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
    )
    appendNativeChatAttachmentCache(
      composerScopeKey,
      blocks.flatMap((block, index) =>
        block.type === 'image-ref' && block.path
          ? [{ id: `withdrawn-${entry.clientMessageId}-${index}`, path: block.path }]
          : []
      )
    )
  }
  return true
}

export function useStructuredAgentSessionWithdrawnRestore(
  /** Absent where no composer shows this session; the caller then keeps the entries. */
  composerScopeKey: string | undefined
): {
  /** Entries a Stop took out of the outbox here, before the host held them; false when the
   *  composer could not take them. */
  byStop: (entries: readonly StructuredAgentSessionOutboxEntry[]) => boolean
} {
  return useMemo(
    () => ({ byStop: (entries) => restoreUnsentMessages(composerScopeKey, entries) }),
    [composerScopeKey]
  )
}

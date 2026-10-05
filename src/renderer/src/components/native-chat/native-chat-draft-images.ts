// The images of a composer's draft, added to without the composer: the one append a hand-back and
// the composer's own picks share. Kept apart from the composer hook, so code that hands a message
// back (a closing chat, a settled send) never loads the composer.

import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import {
  appendToNativeChatComposerDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'

/** Adds settled images after the ones the draft holds now, skipping one it already holds, as a
 *  repeated hand-back does. Durable at once when it returns true: when Stop gives images back, the
 *  copy they came from goes right after this. Only an image the user attaches (`fromUser`) takes the
 *  place of a placeholder with its file name, as a re-pick does. Read against the loaded drafts, as
 *  a hand-back waits for them. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): boolean {
  const held = new Set(readNativeChatComposerDraft(scopeKey).images.map((image) => image.id))
  const images = appended
    .filter((image) => !held.has(image.id))
    // Preview URLs can retain the full clipboard Blob, so only the path is kept.
    .map(({ id, path, connectionId }) => ({ id, path, ...(connectionId ? { connectionId } : {}) }))
  if (images.length === 0) {
    return false
  }
  return appendToNativeChatComposerDraft(scopeKey, {
    images,
    ...(options?.fromUser ? { fromUser: true } : {})
  })
}

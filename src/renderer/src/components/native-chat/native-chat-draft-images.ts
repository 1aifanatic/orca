// The images of a composer's draft, added to without the composer: the one append a hand-back and
// the composer's own picks share. Kept apart from the composer hook, so code that hands a message
// back (a closing chat, a settled send) never loads the composer.

import { basename } from '@/lib/path'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { appendToNativeChatComposerDraft } from './native-chat-composer-draft-store'

/** Adds settled images after the ones the draft holds now, skipping one it already holds, as a
 *  repeated hand-back does. Saved at once: when Stop gives images back, the copy they came from
 *  goes right after this. Only an image the user attaches (`fromUser`) takes the place of a
 *  placeholder with its file name, as a re-pick does. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[],
  options?: { fromUser?: boolean }
): void {
  if (appended.length === 0) {
    return
  }
  // Run on the draft as it is now and, before the startup load lands, again on the loaded one, so
  // the id check also sees images a reload brought back.
  appendToNativeChatComposerDraft(scopeKey, (draft) => {
    const images = [...draft.images]
    for (const { id, path, connectionId } of appended) {
      // Preview URLs can retain the full clipboard Blob, so only the path is kept.
      const image = { id, path, ...(connectionId ? { connectionId } : {}) }
      const placeholder = options?.fromUser
        ? images.findIndex((held) => held.unavailableName === basename(path))
        : -1
      if (placeholder !== -1) {
        images[placeholder] = image
      } else if (!images.some((held) => held.id === id)) {
        images.push(image)
      }
    }
    return { images }
  })
}

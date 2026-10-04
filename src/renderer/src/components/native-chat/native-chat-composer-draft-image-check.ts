// Which restored draft images are known to be gone, through the existing existence check: the
// workspace's own read rules locally, the host over SSH.

import type { NativeChatComposerDraftImage } from './native-chat-composer-draft-storage'
import {
  readNativeChatComposerDraft,
  takeUnverifiedNativeChatComposerDraft,
  unavailableNativeChatComposerDraftImage,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

/** Ids of images whose file is gone. One that cannot be checked (no read permission for that
 *  path, host not connected) counts as present: the send's own check still guards it. */
export async function findMissingNativeChatComposerDraftImages(
  images: readonly NativeChatComposerDraftImage[]
): Promise<Set<string>> {
  const pathExists = typeof window === 'undefined' ? undefined : window.api?.fs?.pathExists
  const missing = new Set<string>()
  if (!pathExists) {
    return missing
  }
  await Promise.all(
    images
      .filter((image) => image.unavailableName === undefined && image.path !== '')
      .map(async (image) => {
        try {
          const exists = await pathExists({
            filePath: image.path,
            ...(image.connectionId ? { connectionId: image.connectionId } : {})
          })
          if (!exists) {
            missing.add(image.id)
          }
        } catch {
          // Unknown, not gone.
        }
      })
  )
  return missing
}

/** Once per restored draft: an image whose file is gone comes back as one to attach again. */
export async function verifyRestoredNativeChatComposerDraftImages(scopeKey: string): Promise<void> {
  if (!takeUnverifiedNativeChatComposerDraft(scopeKey)) {
    return
  }
  const checked = readNativeChatComposerDraft(scopeKey).images
  const missing = await findMissingNativeChatComposerDraftImages(checked)
  if (missing.size === 0) {
    return
  }
  const gone = new Set(checked.filter((image) => missing.has(image.id)).map(({ path }) => path))
  updateNativeChatComposerDraft(
    scopeKey,
    {
      images: readNativeChatComposerDraft(scopeKey).images.map((image) =>
        missing.has(image.id) && gone.has(image.path)
          ? unavailableNativeChatComposerDraftImage(image)
          : image
      )
    },
    'immediate'
  )
}

// What is added to a draft without replacing it: text given back (Stop, a queued card's Edit) and
// images given back or attached. Kept as data, so the same addition can be made again on a draft
// loaded later, or replayed from the journal after a crash.

import { basename } from '@/lib/path'
import type {
  NativeChatComposerDraft,
  NativeChatComposerDraftImage
} from './native-chat-composer-draft-storage'

export type NativeChatComposerDraftAddition = {
  readonly text?: string
  readonly images?: readonly NativeChatComposerDraftImage[]
  /** Only an image the user attaches takes the place of a placeholder with its file name. */
  readonly fromUser?: boolean
}

/** A whitespace-only draft counts as empty, so the text never lands after blank lines. */
export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft.trim() === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

/** Whether the draft already ends with `text` as its own paragraph. */
export function nativeChatDraftEndsWith(draft: string, text: string): boolean {
  const held = draft.trimEnd()
  return held === text || held.endsWith(`\n\n${text}`)
}

/**
 * The draft's text and images with the addition made. `once` makes it again only where it is not
 * already there (text the draft already ends with as its own paragraph, an image id it holds): a
 * replay after a crash meets a draft that may already have been saved with it. Only a whole
 * paragraph counts, so "go" given back onto "please go" still comes back.
 */
export function withNativeChatComposerDraftAddition(
  draft: NativeChatComposerDraft,
  addition: NativeChatComposerDraftAddition,
  options: { once?: boolean } = {}
): Pick<NativeChatComposerDraft, 'text' | 'images'> {
  const added = addition.text ?? ''
  const text =
    added === '' || (options.once && nativeChatDraftEndsWith(draft.text, added))
      ? draft.text
      : appendNativeChatDraftText(draft.text, added)
  const images = [...draft.images]
  for (const { id, path, connectionId } of addition.images ?? []) {
    if (options.once && images.some((held) => held.id === id)) {
      continue
    }
    const image = { id, path, ...(connectionId ? { connectionId } : {}) }
    const placeholder = addition.fromUser
      ? images.findIndex((held) => held.unavailableName === basename(path))
      : -1
    if (placeholder === -1) {
      images.push(image)
    } else {
      images[placeholder] = image
    }
  }
  return { text, images }
}

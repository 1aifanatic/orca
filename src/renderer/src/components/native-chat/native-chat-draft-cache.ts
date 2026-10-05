import type { JSONContent } from '@tiptap/react'
// The composer's in-progress draft text and its editor document, keyed by the same stable pane
// scope as image attachments. The composer unmounts when the pane toggles back to the hosted
// terminal, so without this the typed-but-unsent draft would be lost on every TUI/GUI round-trip.
// A view of native-chat-composer-draft-store, which owns the whole draft and keeps it across a
// reload or quit.

import {
  appendToNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

export function readNativeChatDraftCache(scopeKey: string): string {
  return readNativeChatComposerDraft(scopeKey).text
}

/** `unsaved` shows text this run without saving it while the draft is still exactly that text. */
export function writeNativeChatDraftCache(
  scopeKey: string,
  draft: string,
  options?: { unsaved?: boolean }
): void {
  if (readNativeChatComposerDraft(scopeKey).text === draft) {
    return
  }
  // Cleared at once, so a sent or emptied draft never resurfaces.
  updateNativeChatComposerDraft(
    scopeKey,
    { text: draft, document: undefined, ...(options?.unsaved ? { unsavedText: draft } : {}) },
    draft === '' ? 'immediate' : 'deferred'
  )
}

export { appendNativeChatDraftText } from './native-chat-composer-draft-addition'

// Why: a composer mid-IME-composition keeps showing what it had, so it is told what was appended.
const appendListeners = new Map<string, Set<(text: string, previous: string) => void>>()

/** Puts text back after whatever is typed, and tells a mounted composer to show it. True once it
 *  is durable, so the copy it came from may go. */
export function appendNativeChatDraftCache(scopeKey: string, text: string): boolean {
  if (text === '') {
    return true
  }
  const previous = readNativeChatDraftCache(scopeKey)
  // Durable now: the copy it came from (an outbox entry, a queued card) goes right after this.
  const durable = appendToNativeChatComposerDraft(scopeKey, { text })
  appendListeners.get(scopeKey)?.forEach((listener) => listener(text, previous))
  return durable
}

/** Whether the draft already ends with `returned` as its own paragraph. */
function draftEndsWith(draft: string, returned: string): boolean {
  const held = draft.trimEnd()
  return held === returned || held.endsWith(`\n\n${returned}`)
}

/**
 * Hands text Orca could not deliver back to the person, with or without a composer showing it.
 * True when its addition is durable now, so the copy it came from may go; false leaves that to the
 * scope's next confirmed write (nothing was added, or the journal couldn't take it). Why skipped when the draft already ends
 * with it: a hand-back can repeat (a crash before its copy was removed, two windows settling one
 * message), and the person must see it once. Only the end counts, so text that merely appears
 * inside a longer draft still comes back; two identical messages returned one after the other come
 * back as one, as in the common pattern. Read against the loaded drafts: the caller waits for the
 * startup load, since an addition made before it is applied again to the loaded draft.
 */
export function returnNativeChatDraftText(scopeKey: string, text: string): boolean {
  // Only the end is trimmed, as a send trims it: a first line's indentation is part of the text.
  const returned = text.trimEnd()
  if (returned.trim() === '' || draftEndsWith(readNativeChatDraftCache(scopeKey), returned)) {
    return false
  }
  return appendNativeChatDraftCache(scopeKey, returned)
}

export function subscribeToNativeChatDraftAppend(
  scopeKey: string,
  listener: (text: string, previous: string) => void
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

export function clearNativeChatDraftCacheForTests(): void {
  clearNativeChatComposerDraftsForTests()
}

export function readNativeChatDraftDocument(
  scopeKey: string,
  text: string
): JSONContent | undefined {
  const draft = readNativeChatComposerDraft(scopeKey)
  return draft.text === text ? draft.document : undefined
}

export function writeNativeChatDraftDocument(
  scopeKey: string,
  text: string,
  document: JSONContent
): void {
  if (!text) {
    writeNativeChatDraftCache(scopeKey, '')
    return
  }
  updateNativeChatComposerDraft(scopeKey, { text, document }, 'deferred')
}

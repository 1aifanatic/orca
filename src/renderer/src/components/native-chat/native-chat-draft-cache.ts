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

/** A whitespace-only draft counts as empty, so the text never lands after blank lines. */
export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft.trim() === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

// Why: a composer mid-IME-composition keeps showing what it had, so it is told what was appended.
const appendListeners = new Map<string, Set<(text: string, previous: string) => void>>()

/** Appends `text` unless `holds` says the draft already ends with it, checked against the draft as
 *  it is now and, before the startup load lands, against the loaded one too. */
function appendToDraft(
  scopeKey: string,
  text: string,
  holds: (draft: string) => boolean = () => false
): void {
  const previous = readNativeChatDraftCache(scopeKey)
  if (holds(previous)) {
    return
  }
  // Saved now: the copy it came from (an outbox entry, a queued card) goes right after this.
  appendToNativeChatComposerDraft(scopeKey, (draft) =>
    holds(draft.text)
      ? {}
      : { text: appendNativeChatDraftText(draft.text, text), document: undefined }
  )
  appendListeners.get(scopeKey)?.forEach((listener) => listener(text, previous))
}

/** Puts text back after whatever is typed, and tells a mounted composer to show it. */
export function appendNativeChatDraftCache(scopeKey: string, text: string): void {
  if (text === '') {
    return
  }
  appendToDraft(scopeKey, text)
}

/**
 * Hands text Orca could not deliver back to the person, with or without a composer showing it.
 * Why skipped when the draft already ends with it: a hand-back can repeat (a crash before its copy
 * was removed, two windows settling one message), and the person must see it once. Only the end
 * counts, so text that merely appears inside a longer draft still comes back; two identical
 * messages returned one after the other come back as one, as in the common pattern.
 */
export function returnNativeChatDraftText(scopeKey: string, text: string): void {
  // Only the end is trimmed, as a send trims it: a first line's indentation is part of the text.
  const returned = text.trimEnd()
  if (returned.trim() === '') {
    return
  }
  appendToDraft(scopeKey, returned, (draft) => {
    const held = draft.trimEnd()
    return held === returned || held.endsWith(`\n\n${returned}`)
  })
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

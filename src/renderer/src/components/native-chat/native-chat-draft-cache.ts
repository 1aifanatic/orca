import type { JSONContent } from '@tiptap/react'
// Module-level cache for the composer's unsent message (text and image attachments), keyed by
// stable pane scope. The composer unmounts when the pane toggles back to the hosted terminal, so
// without this the draft would be lost on every TUI/GUI round-trip. The cache is backed by disk
// (native-chat-draft-storage) so the draft also survives quitting Orca.

import {
  NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX,
  setBoundedScopeCacheEntry
} from './native-chat-composer-scope-cache'
import {
  loadPersistedNativeChatDrafts,
  persistNativeChatDraftNow,
  resetNativeChatDraftStorageForTests,
  scheduleNativeChatDraftPersist,
  type NativeChatDraftAttachment,
  type NativeChatDraftWriteResult,
  type PersistedNativeChatDraft
} from './native-chat-draft-storage'

export type { NativeChatDraftAttachment, NativeChatDraftWriteResult }

type DraftEntry = {
  text: string
  /** Rich editor state; memory only, rebuilt from the text after a restart. */
  document?: JSONContent
  attachments: readonly NativeChatDraftAttachment[]
}

const draftCache = new Map<string, DraftEntry>()
let hydrated = false

function drafts(): Map<string, DraftEntry> {
  if (!hydrated) {
    hydrated = true
    for (const [scopeKey, draft] of loadPersistedNativeChatDrafts(
      NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX
    )) {
      draftCache.set(scopeKey, { text: draft.text, attachments: draft.attachments })
    }
  }
  return draftCache
}

function readEntry(scopeKey: string): DraftEntry {
  return drafts().get(scopeKey) ?? { text: '', attachments: [] }
}

function setEntry(scopeKey: string, entry: DraftEntry): void {
  // An empty draft carries no state worth retaining; drop it so a stale scope never resurrects it.
  if (entry.text === '' && entry.attachments.length === 0) {
    drafts().delete(scopeKey)
    return
  }
  setBoundedScopeCacheEntry(drafts(), scopeKey, entry, (evicted) =>
    persistNativeChatDraftNow(evicted, null)
  )
}

function persistedDraft(scopeKey: string): PersistedNativeChatDraft | null {
  const entry = drafts().get(scopeKey)
  return entry ? { text: entry.text, attachments: entry.attachments } : null
}

function persistNow(scopeKey: string): NativeChatDraftWriteResult {
  return persistNativeChatDraftNow(scopeKey, persistedDraft(scopeKey))
}

/** Typing waits for a pause; emptying the text (the clear at send) is written at once. */
function persistTextEdit(scopeKey: string, text: string): void {
  if (text === '') {
    persistNow(scopeKey)
  } else {
    scheduleNativeChatDraftPersist(scopeKey, persistedDraft(scopeKey))
  }
}

export function readNativeChatDraftCache(scopeKey: string): string {
  return readEntry(scopeKey).text
}

export function writeNativeChatDraftCache(scopeKey: string, draft: string): void {
  const current = readEntry(scopeKey)
  setEntry(scopeKey, {
    text: draft,
    document: current.text === draft ? current.document : undefined,
    attachments: current.attachments
  })
  persistTextEdit(scopeKey, draft)
}

export function readNativeChatDraftAttachments(scopeKey: string): NativeChatDraftAttachment[] {
  return [...readEntry(scopeKey).attachments]
}

/** Attachment changes are discrete, so they are written at once. */
export function writeNativeChatDraftAttachments(
  scopeKey: string,
  attachments: readonly NativeChatDraftAttachment[]
): void {
  setEntry(scopeKey, { ...readEntry(scopeKey), attachments: [...attachments] })
  persistNow(scopeKey)
}

export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

// Only a write from outside the composer notifies; its own writes already hold the content.
const textAppendListeners = new Map<string, Set<(text: string) => void>>()
const attachmentAppendListeners = new Map<
  string,
  Set<(appended: readonly NativeChatDraftAttachment[]) => void>
>()

export type NativeChatDraftContent = {
  text: string
  attachments?: readonly NativeChatDraftAttachment[]
}

/**
 * Puts content back after whatever is in the composer, writes it to disk at once, and shows it in
 * a mounted composer. The result says whether it reached disk.
 */
export function appendNativeChatDraftNow(
  scopeKey: string,
  content: NativeChatDraftContent
): NativeChatDraftWriteResult {
  const attachments = content.attachments ?? []
  const current = readEntry(scopeKey)
  const text =
    content.text === '' ? current.text : appendNativeChatDraftText(current.text, content.text)
  setEntry(scopeKey, {
    text,
    document: text === current.text ? current.document : undefined,
    attachments: [...current.attachments, ...attachments]
  })
  const result = persistNow(scopeKey)
  if (content.text !== '') {
    textAppendListeners.get(scopeKey)?.forEach((listener) => listener(content.text))
  }
  if (attachments.length > 0) {
    attachmentAppendListeners.get(scopeKey)?.forEach((listener) => listener(attachments))
  }
  return result
}

/** Puts content back only into an empty composer, so nothing the user typed since is touched. */
export function restoreNativeChatDraftIfEmpty(
  scopeKey: string,
  content: NativeChatDraftContent
): NativeChatDraftWriteResult | 'composer-not-empty' {
  const current = readEntry(scopeKey)
  if (current.text !== '' || current.attachments.length > 0) {
    return 'composer-not-empty'
  }
  return appendNativeChatDraftNow(scopeKey, content)
}

function subscribe<T>(
  listenersByScope: Map<string, Set<(value: T) => void>>,
  scopeKey: string,
  listener: (value: T) => void
): () => void {
  const listeners = listenersByScope.get(scopeKey) ?? new Set()
  listenersByScope.set(scopeKey, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByScope.get(scopeKey) === listeners) {
      listenersByScope.delete(scopeKey)
    }
  }
}

export function subscribeToNativeChatDraftAppend(
  scopeKey: string,
  listener: (text: string) => void
): () => void {
  return subscribe(textAppendListeners, scopeKey, listener)
}

export function subscribeToNativeChatDraftAttachmentAppend(
  scopeKey: string,
  listener: (appended: readonly NativeChatDraftAttachment[]) => void
): () => void {
  return subscribe(attachmentAppendListeners, scopeKey, listener)
}

/** Clears memory and the saved drafts on disk. */
export function clearNativeChatDraftCacheForTests(): void {
  draftCache.clear()
  hydrated = false
  resetNativeChatDraftStorageForTests()
}

export function readNativeChatDraftDocument(
  scopeKey: string,
  text: string
): JSONContent | undefined {
  const cached = readEntry(scopeKey)
  return cached.text === text ? cached.document : undefined
}

export function writeNativeChatDraftDocument(
  scopeKey: string,
  text: string,
  document: JSONContent
): void {
  setEntry(scopeKey, {
    text,
    document: text ? document : undefined,
    attachments: readEntry(scopeKey).attachments
  })
  persistTextEdit(scopeKey, text)
}

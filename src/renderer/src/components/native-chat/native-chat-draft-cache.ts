import type { JSONContent } from '@tiptap/react'
// One unsent message (text and image attachments) per chat, shared by every view of that chat and
// saved to disk (native-chat-draft-storage) so it survives quitting Orca. Views mirror it and
// subscribe to changes, so typing in one pane shows in every other pane on the same chat.

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

/**
 * The chat a draft belongs to. A structured chat is its session, whichever pane shows it. A chat
 * over a terminal agent has no stable session (it changes on `/clear` and on resume), and its
 * agent lives in exactly one pane, so the pane is the chat.
 */
export function nativeChatDraftKey(chat: { sessionId?: string; paneKey: string }): string {
  return chat.sessionId ? `session:${chat.sessionId}` : `pane:${chat.paneKey}`
}

type DraftEntry = { text: string; attachments: readonly NativeChatDraftAttachment[] }

const EMPTY_ATTACHMENTS: readonly NativeChatDraftAttachment[] = []
const draftCache = new Map<string, DraftEntry>()
let hydrated = false

function drafts(): Map<string, DraftEntry> {
  if (!hydrated) {
    hydrated = true
    for (const [draftKey, draft] of loadPersistedNativeChatDrafts(
      NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX
    )) {
      draftCache.set(draftKey, { text: draft.text, attachments: draft.attachments })
    }
  }
  return draftCache
}

function readEntry(draftKey: string): DraftEntry {
  return drafts().get(draftKey) ?? { text: '', attachments: EMPTY_ATTACHMENTS }
}

/** An attachment write carries its view's token, so that view can skip its own echo. */
const changeListeners = new Map<string, Set<(writer: object | undefined) => void>>()

function setEntry(draftKey: string, entry: DraftEntry, writer: object | undefined): void {
  // An empty draft carries no state worth retaining; drop it so a stale key never resurrects it.
  if (entry.text === '' && entry.attachments.length === 0) {
    drafts().delete(draftKey)
  } else {
    setBoundedScopeCacheEntry(drafts(), draftKey, entry, (evicted) =>
      persistNativeChatDraftNow(evicted, null)
    )
  }
  changeListeners.get(draftKey)?.forEach((listener) => listener(writer))
}

function persistedDraft(draftKey: string): PersistedNativeChatDraft | null {
  const entry = drafts().get(draftKey)
  return entry ? { text: entry.text, attachments: entry.attachments } : null
}

function persistNow(draftKey: string): NativeChatDraftWriteResult {
  return persistNativeChatDraftNow(draftKey, persistedDraft(draftKey))
}

export function readNativeChatDraftCache(draftKey: string): string {
  return readEntry(draftKey).text
}

/** Typing waits for a pause; emptying the text (the clear at send) is written at once. */
export function writeNativeChatDraftCache(draftKey: string, draft: string): void {
  setEntry(draftKey, { ...readEntry(draftKey), text: draft }, undefined)
  if (draft === '') {
    persistNow(draftKey)
  } else {
    scheduleNativeChatDraftPersist(draftKey, persistedDraft(draftKey))
  }
}

export function readNativeChatDraftAttachments(
  draftKey: string
): readonly NativeChatDraftAttachment[] {
  return readEntry(draftKey).attachments
}

/** Settled attachments only; a view keeps its own pending chips and previews. Written at once. */
export function writeNativeChatDraftAttachments(
  draftKey: string,
  attachments: readonly NativeChatDraftAttachment[],
  writer?: object
): void {
  setEntry(draftKey, { ...readEntry(draftKey), attachments: [...attachments] }, writer)
  persistNow(draftKey)
}

/** Fires on every change to the chat's draft, with the writing view's token if it gave one. */
export function subscribeToNativeChatDraft(
  draftKey: string,
  listener: (writer: object | undefined) => void
): () => void {
  return subscribe(changeListeners, draftKey, listener)
}

export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

// A composing view cannot show appended text until its IME settles, so it is told what was added.
const textAppendListeners = new Map<string, Set<(text: string) => void>>()

export type NativeChatDraftContent = {
  text: string
  attachments?: readonly NativeChatDraftAttachment[]
}

/**
 * Puts content back after whatever is in the chat's draft, writes it to disk at once, and shows it
 * in every view of the chat. The result says whether it reached disk.
 */
export function appendNativeChatDraftNow(
  draftKey: string,
  content: NativeChatDraftContent
): NativeChatDraftWriteResult {
  const attachments = content.attachments ?? []
  const current = readEntry(draftKey)
  if (content.text !== '') {
    textAppendListeners.get(draftKey)?.forEach((listener) => listener(content.text))
  }
  setEntry(
    draftKey,
    {
      text:
        content.text === '' ? current.text : appendNativeChatDraftText(current.text, content.text),
      attachments: [...current.attachments, ...attachments]
    },
    undefined
  )
  return persistNow(draftKey)
}

/** Puts content back only into an empty draft, so nothing the user typed since is touched. */
export function restoreNativeChatDraftIfEmpty(
  draftKey: string,
  content: NativeChatDraftContent
): NativeChatDraftWriteResult | 'composer-not-empty' {
  const current = readEntry(draftKey)
  if (current.text !== '' || current.attachments.length > 0) {
    return 'composer-not-empty'
  }
  return appendNativeChatDraftNow(draftKey, content)
}

function subscribe<T>(
  listenersByKey: Map<string, Set<(value: T) => void>>,
  key: string,
  listener: (value: T) => void
): () => void {
  const listeners = listenersByKey.get(key) ?? new Set()
  listenersByKey.set(key, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && listenersByKey.get(key) === listeners) {
      listenersByKey.delete(key)
    }
  }
}

export function subscribeToNativeChatDraftAppend(
  draftKey: string,
  listener: (text: string) => void
): () => void {
  return subscribe(textAppendListeners, draftKey, listener)
}

// Rich editor state belongs to the pane's editor, not the chat; memory only.
const documentCache = new Map<string, { text: string; document: JSONContent }>()

/** Clears memory and the saved drafts on disk. */
export function clearNativeChatDraftCacheForTests(): void {
  draftCache.clear()
  documentCache.clear()
  hydrated = false
  resetNativeChatDraftStorageForTests()
}

export function readNativeChatDraftDocument(
  paneKey: string,
  text: string
): JSONContent | undefined {
  const cached = documentCache.get(paneKey)
  return cached?.text === text ? cached.document : undefined
}

export function writeNativeChatDraftDocument(
  paneKey: string,
  text: string,
  document: JSONContent
): void {
  if (!text) {
    documentCache.delete(paneKey)
    return
  }
  setBoundedScopeCacheEntry(documentCache, paneKey, { text, document })
}

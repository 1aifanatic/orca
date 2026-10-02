// The composer's unsent message — text, its editor document and settled image refs — kept in
// localStorage per pane scope, so a reload or quit keeps what was typed or given back to it. The
// in-memory caches (native-chat-draft-cache, the attachment cache) stay the working copy; this is
// what they fall back to on a miss.

import type { JSONContent } from '@tiptap/react'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from './native-chat-composer-scope-cache'

const DRAFT_KEY_PREFIX = 'orca:nativeChatComposerDraft:v1:'
const PERSIST_DEBOUNCE_MS = 250
// Why: drafts share the origin's storage quota with the outbox, which must never fail to save a
// send because a pasted log filled it; a larger draft stays in memory only.
const MAX_PERSISTED_DRAFT_CHARS = 200_000

export type PersistedNativeChatDraftAttachment = {
  id: string
  path: string
  connectionId?: string
}

export type PersistedNativeChatDraft = {
  text: string
  document?: JSONContent
  attachments: PersistedNativeChatDraftAttachment[]
}

const EMPTY_DRAFT: PersistedNativeChatDraft = { text: '', attachments: [] }

const pendingDrafts = new Map<string, PersistedNativeChatDraft>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnHideInstalled = false

function storageKey(scopeKey: string): string {
  return `${DRAFT_KEY_PREFIX}${encodeURIComponent(scopeKey)}`
}

function draftStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only the editor's own root node is restored; anything else falls back to the plain text. */
function isEditorDocument(value: unknown): value is JSONContent {
  return isRecord(value) && value.type === 'doc'
}

function parseAttachment(value: unknown): PersistedNativeChatDraftAttachment | null {
  if (!isRecord(value)) {
    return null
  }
  const { id, path, connectionId } = value
  if (typeof id !== 'string' || typeof path !== 'string' || path === '') {
    return null
  }
  return { id, path, ...(typeof connectionId === 'string' ? { connectionId } : {}) }
}

function parseStoredDraft(
  raw: string | null
): (PersistedNativeChatDraft & { savedAt: number }) | null {
  if (raw === null) {
    return null
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) {
      return null
    }
    const { text, document, attachments, savedAt } = value
    if (typeof text !== 'string' || typeof savedAt !== 'number' || !Array.isArray(attachments)) {
      return null
    }
    return {
      text,
      ...(isEditorDocument(document) ? { document } : {}),
      attachments: attachments.flatMap((attachment) => parseAttachment(attachment) ?? []),
      savedAt
    }
  } catch {
    return null
  }
}

function isEmptyDraft(draft: PersistedNativeChatDraft): boolean {
  return draft.text === '' && draft.attachments.length === 0
}

/** The serialized draft, without its document when that alone makes it too large; null when even
 *  the text and image refs are. */
function serializeDraft(draft: PersistedNativeChatDraft, savedAt: number): string | null {
  const withDocument = JSON.stringify({ ...draft, savedAt })
  if (withDocument.length <= MAX_PERSISTED_DRAFT_CHARS) {
    return withDocument
  }
  const { document: _dropped, ...plain } = draft
  const withoutDocument = JSON.stringify({ ...plain, savedAt })
  return withoutDocument.length <= MAX_PERSISTED_DRAFT_CHARS ? withoutDocument : null
}

/** Keeps the newest drafts within the composer caches' own bound; the rest are for panes long
 *  closed. Malformed records go too. */
function pruneStoredDrafts(storage: Storage): void {
  const stored: { key: string; savedAt: number }[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(DRAFT_KEY_PREFIX)) {
      stored.push({ key, savedAt: parseStoredDraft(storage.getItem(key))?.savedAt ?? -1 })
    }
  }
  stored.sort((left, right) => right.savedAt - left.savedAt)
  for (const [index, { key, savedAt }] of stored.entries()) {
    if (savedAt < 0 || index >= NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX) {
      storage.removeItem(key)
    }
  }
}

export function flushPersistedNativeChatDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const storage = draftStorage()
  if (!storage || pendingDrafts.size === 0) {
    pendingDrafts.clear()
    return
  }
  const savedAt = Date.now()
  for (const [scopeKey, draft] of pendingDrafts) {
    try {
      const serialized = isEmptyDraft(draft) ? null : serializeDraft(draft, savedAt)
      if (serialized === null) {
        storage.removeItem(storageKey(scopeKey))
      } else {
        storage.setItem(storageKey(scopeKey), serialized)
      }
    } catch {
      // Over quota: the composer's memory copy still holds it for this run.
    }
  }
  pendingDrafts.clear()
  try {
    pruneStoredDrafts(storage)
  } catch {
    // Pruning is bookkeeping; a failure leaves extra drafts for the next flush.
  }
}

function installFlushOnHide(): void {
  if (flushOnHideInstalled || typeof window === 'undefined') {
    return
  }
  flushOnHideInstalled = true
  // Why: a debounced write still pending when the window reloads or closes would lose the last
  // keystrokes.
  window.addEventListener('pagehide', flushPersistedNativeChatDrafts)
  window.addEventListener('beforeunload', flushPersistedNativeChatDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPersistedNativeChatDrafts()
    }
  })
}

export function readPersistedNativeChatDraft(scopeKey: string): PersistedNativeChatDraft | null {
  const pending = pendingDrafts.get(scopeKey)
  if (pending) {
    return pending
  }
  const storage = draftStorage()
  if (!storage) {
    return null
  }
  try {
    const stored = parseStoredDraft(storage.getItem(storageKey(scopeKey)))
    if (!stored) {
      return null
    }
    const { savedAt: _savedAt, ...draft } = stored
    return draft
  } catch {
    return null
  }
}

/**
 * Records one part of a scope's draft. `immediate` is for text given back to the composer (a
 * Stop's withdrawn message, an edited queued card): its other copy is about to go, so it is saved
 * before that. Typing is `deferred` and coalesced.
 */
export function persistNativeChatDraftPart(
  scopeKey: string,
  part: Partial<PersistedNativeChatDraft>,
  mode: 'immediate' | 'deferred'
): void {
  if (!draftStorage()) {
    return
  }
  const base = readPersistedNativeChatDraft(scopeKey) ?? EMPTY_DRAFT
  const next: PersistedNativeChatDraft = { ...base, ...part }
  if (next.document === undefined) {
    delete next.document
  }
  pendingDrafts.set(scopeKey, next)
  // Clearing is immediate too, so a stored copy never outlives a sent or emptied draft.
  if (mode === 'immediate' || isEmptyDraft(next)) {
    flushPersistedNativeChatDrafts()
    return
  }
  installFlushOnHide()
  if (flushTimer === null) {
    flushTimer = setTimeout(flushPersistedNativeChatDrafts, PERSIST_DEBOUNCE_MS)
  }
}

export function clearPersistedNativeChatDraftsForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingDrafts.clear()
  const storage = draftStorage()
  if (!storage) {
    return
  }
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(DRAFT_KEY_PREFIX)) {
      keys.push(key)
    }
  }
  for (const key of keys) {
    storage.removeItem(key)
  }
}

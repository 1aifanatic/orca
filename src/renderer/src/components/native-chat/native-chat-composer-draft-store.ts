// The one owner of each composer scope's unsent message: its text, the editor document for that
// text and its settled image refs. Every writer changes the whole record here in memory, and
// storage is written from that record, so a reload or quit gives the draft back and a failed or
// skipped write is repaired by the next one.

import type { JSONContent } from '@tiptap/react'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import {
  clearStoredNativeChatComposerDraftsForTests,
  enforceStoredNativeChatComposerDraftBounds,
  indexStoredNativeChatComposerDrafts,
  nativeChatComposerDraftStorage,
  nativeChatComposerDraftStorageKey,
  parseStoredNativeChatComposerDraft,
  removeStoredNativeChatComposerDraft,
  removeStoredNativeChatComposerDraftsByScopePrefix,
  writeStoredNativeChatComposerDraft,
  type NativeChatComposerDraft,
  type NativeChatComposerDraftImage,
  type StoredNativeChatComposerDraft
} from './native-chat-composer-draft-storage'

const PERSIST_DEBOUNCE_MS = 250

export type NativeChatComposerDraftChange = {
  text?: string
  /** Present, even as undefined, to replace the document. */
  document?: JSONContent
  images?: readonly NativeChatComposerDraftImage[]
  /** Text shown but never saved while the draft still holds exactly it. */
  unsavedText?: string
}

// Why unsavedText: an adopted launch seed is also parked in the agent's input line, and only this
// run's seed knows to replace it, so a reload must not bring the copy back.
type DraftRecord = StoredNativeChatComposerDraft & { readonly unsavedText?: string }

const EMPTY_DRAFT: DraftRecord = { text: '', images: [], savedAt: 0 }

const records = new Map<string, DraftRecord>()
// Scopes whose record storage does not hold yet; a refused write stays here for the next flush.
const dirtyScopes = new Set<string>()
let lastSavedAt = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushOnHideInstalled = false

function isEmptyDraft(draft: NativeChatComposerDraft): boolean {
  return draft.text === '' && draft.images.length === 0
}

function sameImages(
  left: readonly NativeChatComposerDraftImage[],
  right: readonly NativeChatComposerDraftImage[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (image, index) =>
        image.id === right[index].id &&
        image.path === right[index].path &&
        image.connectionId === right[index].connectionId
    )
  )
}

/** Monotonic within a run, so drafts changed in the same millisecond still age in order. */
function nextSavedAt(): number {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1)
  return lastSavedAt
}

function writeRecord(storage: Storage, scopeKey: string, record: DraftRecord): void {
  const { unsavedText, ...saved } = record
  if (saved.text === unsavedText && saved.images.length === 0) {
    removeStoredNativeChatComposerDraft(storage, nativeChatComposerDraftStorageKey(scopeKey))
    dirtyScopes.delete(scopeKey)
    return
  }
  const stored =
    saved.text === unsavedText ? { text: '', images: saved.images, savedAt: saved.savedAt } : saved
  if (writeStoredNativeChatComposerDraft(storage, scopeKey, stored)) {
    dirtyScopes.delete(scopeKey)
  }
}

// A draft leaving memory before its write landed is written on the way out.
function writeEvictedRecord(scopeKey: string, record: DraftRecord): void {
  const storage = dirtyScopes.has(scopeKey) ? nativeChatComposerDraftStorage() : null
  if (storage) {
    writeRecord(storage, scopeKey, record)
  }
  dirtyScopes.delete(scopeKey)
}

export function flushNativeChatComposerDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (dirtyScopes.size === 0) {
    return
  }
  const storage = nativeChatComposerDraftStorage()
  if (!storage) {
    dirtyScopes.clear()
    return
  }
  indexStoredNativeChatComposerDrafts(storage)
  for (const scopeKey of dirtyScopes) {
    const record = records.get(scopeKey)
    if (record) {
      writeRecord(storage, scopeKey, record)
    } else {
      dirtyScopes.delete(scopeKey)
    }
  }
  enforceStoredNativeChatComposerDraftBounds(storage)
}

function installFlushOnHide(): void {
  if (
    flushOnHideInstalled ||
    typeof window === 'undefined' ||
    typeof window.addEventListener !== 'function' ||
    typeof document === 'undefined'
  ) {
    return
  }
  flushOnHideInstalled = true
  // Why: a deferred write still pending when the window reloads or closes would lose the last
  // keystrokes.
  window.addEventListener('pagehide', flushNativeChatComposerDrafts)
  window.addEventListener('beforeunload', flushNativeChatComposerDrafts)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushNativeChatComposerDrafts()
    }
  })
}

/** The scope's record, read from storage the first time this run asks for it. */
function loadRecord(scopeKey: string): DraftRecord | undefined {
  const held = records.get(scopeKey)
  if (held) {
    return held
  }
  const storage = nativeChatComposerDraftStorage()
  if (!storage) {
    return undefined
  }
  try {
    const stored = parseStoredNativeChatComposerDraft(
      storage.getItem(nativeChatComposerDraftStorageKey(scopeKey))
    )
    if (!stored) {
      return undefined
    }
    setBoundedScopeCacheEntry(records, scopeKey, stored, writeEvictedRecord)
    return stored
  } catch {
    return undefined
  }
}

export function readNativeChatComposerDraft(scopeKey: string): NativeChatComposerDraft {
  return loadRecord(scopeKey) ?? EMPTY_DRAFT
}

/**
 * Changes fields of the scope's draft. `deferred` is for typing, coalesced into one write;
 * `immediate` saves now: text or images given back from a copy about to be deleted, and clears.
 * An emptied draft is removed at once, so a sent message never comes back.
 */
export function updateNativeChatComposerDraft(
  scopeKey: string,
  change: NativeChatComposerDraftChange,
  persist: 'immediate' | 'deferred'
): void {
  const current = loadRecord(scopeKey) ?? EMPTY_DRAFT
  const text = change.text ?? current.text
  const document = 'document' in change ? change.document : current.document
  const images = change.images ?? current.images
  const unsavedText = change.unsavedText ?? current.unsavedText
  if (
    text === current.text &&
    document === current.document &&
    unsavedText === current.unsavedText &&
    sameImages(images, current.images)
  ) {
    if (persist === 'immediate' && dirtyScopes.has(scopeKey)) {
      flushNativeChatComposerDrafts()
    }
    return
  }
  if (isEmptyDraft({ text, images })) {
    records.delete(scopeKey)
    dirtyScopes.delete(scopeKey)
    const storage = nativeChatComposerDraftStorage()
    if (storage) {
      removeStoredNativeChatComposerDraft(storage, nativeChatComposerDraftStorageKey(scopeKey))
    }
    return
  }
  const record: DraftRecord = {
    text,
    ...(document ? { document } : {}),
    images: [...images],
    savedAt: nextSavedAt(),
    ...(unsavedText === undefined ? {} : { unsavedText })
  }
  setBoundedScopeCacheEntry(records, scopeKey, record, writeEvictedRecord)
  dirtyScopes.add(scopeKey)
  installFlushOnHide()
  if (persist === 'immediate') {
    flushNativeChatComposerDrafts()
    return
  }
  flushTimer ??= setTimeout(flushNativeChatComposerDrafts, PERSIST_DEBOUNCE_MS)
}

/** Drops the drafts of every pane in a tab the user closed; its pane keys never come back. */
export function deleteNativeChatComposerDraftsForTab(tabId: string): void {
  const scopePrefix = `${tabId}:`
  for (const scopeKey of records.keys()) {
    if (scopeKey.startsWith(scopePrefix)) {
      records.delete(scopeKey)
      dirtyScopes.delete(scopeKey)
    }
  }
  const storage = nativeChatComposerDraftStorage()
  if (storage) {
    removeStoredNativeChatComposerDraftsByScopePrefix(storage, scopePrefix)
  }
}

export function clearNativeChatComposerDraftsForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  records.clear()
  dirtyScopes.clear()
  clearStoredNativeChatComposerDraftsForTests()
}

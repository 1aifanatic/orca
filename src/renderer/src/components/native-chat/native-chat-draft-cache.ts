import type { JSONContent } from '@tiptap/react'
// Module-level cache for the composer's in-progress draft text, keyed by the
// same stable pane scope as image attachments. The composer unmounts when the
// pane toggles back to the hosted terminal, so without this the typed-but-unsent
// draft would be lost on every TUI/GUI round-trip. Mirrors the attachment cache
// so both halves of an unsent message survive toggles and reconnects; both are
// saved through native-chat-draft-storage, so they survive a reload or quit too.

import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'
import {
  clearPersistedNativeChatDraftsForTests,
  flushPersistedNativeChatDrafts,
  persistNativeChatDraftPart,
  readPersistedNativeChatDraft
} from './native-chat-draft-storage'

type CachedDraft = { text: string; document?: JSONContent }

const draftCache = new Map<string, CachedDraft>()

/** The scope's draft, read back from storage when this run has not held it yet (a reload). */
function cachedDraft(scopeKey: string): CachedDraft | undefined {
  const cached = draftCache.get(scopeKey)
  if (cached) {
    return cached
  }
  const persisted = readPersistedNativeChatDraft(scopeKey)
  if (!persisted?.text) {
    return undefined
  }
  const restored = {
    text: persisted.text,
    ...(persisted.document ? { document: persisted.document } : {})
  }
  setBoundedScopeCacheEntry(draftCache, scopeKey, restored)
  return restored
}

function setCachedDraft(scopeKey: string, draft: CachedDraft): void {
  // LRU-bounded so unsent drafts for permanently-removed panes can't accumulate.
  setBoundedScopeCacheEntry(draftCache, scopeKey, draft)
  persistNativeChatDraftPart(scopeKey, { text: draft.text, document: draft.document }, 'deferred')
}

export function readNativeChatDraftCache(scopeKey: string): string {
  return cachedDraft(scopeKey)?.text ?? ''
}

export function writeNativeChatDraftCache(scopeKey: string, draft: string): void {
  // An empty draft carries no state worth retaining; drop the entry so a stale
  // scope key never resurrects cleared text.
  if (draft === '') {
    draftCache.delete(scopeKey)
    persistNativeChatDraftPart(scopeKey, { text: '', document: undefined }, 'immediate')
    return
  }
  const cached = cachedDraft(scopeKey)
  setCachedDraft(scopeKey, {
    text: draft,
    ...(cached?.text === draft && cached.document ? { document: cached.document } : {})
  })
}

export function appendNativeChatDraftText(draft: string, text: string): string {
  return draft === '' ? text : `${draft.trimEnd()}\n\n${text}`
}

// Only a write from outside the composer notifies; its own writes already hold the text.
const appendListeners = new Map<string, Set<(text: string) => void>>()

/** Puts text back after whatever is typed, and tells a mounted composer to show it. */
export function appendNativeChatDraftCache(scopeKey: string, text: string): void {
  if (text === '') {
    return
  }
  writeNativeChatDraftCache(
    scopeKey,
    appendNativeChatDraftText(readNativeChatDraftCache(scopeKey), text)
  )
  // Saved now: the copy it came from (an outbox entry, a queued card) goes right after this.
  flushPersistedNativeChatDrafts()
  appendListeners.get(scopeKey)?.forEach((listener) => listener(text))
}

export function subscribeToNativeChatDraftAppend(
  scopeKey: string,
  listener: (text: string) => void
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
  draftCache.clear()
  clearPersistedNativeChatDraftsForTests()
}

export function readNativeChatDraftDocument(
  scopeKey: string,
  text: string
): JSONContent | undefined {
  const cached = cachedDraft(scopeKey)
  return cached?.text === text ? cached.document : undefined
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
  setCachedDraft(scopeKey, { text, document })
}

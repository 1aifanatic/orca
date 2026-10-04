// The draft store's memory, shared by its API (the store module) and its persistence. Memory is
// the owner of every draft; storage only keeps a copy of it.

import type { StoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

// Why unsavedText: an adopted launch seed is also parked in the agent's input line, and only this
// run's seed knows to replace it, so a reload must not bring the copy back.
export type DraftRecord = StoredNativeChatComposerDraft & { readonly unsavedText?: string }

/** A write or removal handed to storage and not yet confirmed; `draft` is null for a removal. */
export type UnconfirmedDraftChange = {
  readonly draft: StoredNativeChatComposerDraft | null
  readonly at: number
}

export const records = new Map<string, DraftRecord>()
// Changed in memory with no write issued yet; a refused write comes back here for the next flush.
export const dirtyScopes = new Set<string>()
export const unconfirmed = new Map<string, UnconfirmedDraftChange>()
// Drafts whose last write storage refused; shown so the user knows they are held in memory only.
export const refusedScopes = new Set<string>()
// Records read back from storage this run whose image files have not been checked yet.
export const unverifiedScopes = new Set<string>()
export const scopeListeners = new Map<string, Set<() => void>>()

let lastSavedAt = 0

/** Monotonic within a run, so drafts changed in the same millisecond still age in order. */
export function nextSavedAt(): number {
  lastSavedAt = Math.max(Date.now(), lastSavedAt + 1)
  return lastSavedAt
}

export function notifyScope(scopeKey: string): void {
  scopeListeners.get(scopeKey)?.forEach((listener) => listener())
}

/** A local change not yet in storage, which a write from another window must not replace. */
export function hasLocalChange(scopeKey: string): boolean {
  return dirtyScopes.has(scopeKey) || unconfirmed.has(scopeKey)
}

export function clearDraftMemoryForTests(): void {
  records.clear()
  dirtyScopes.clear()
  unconfirmed.clear()
  refusedScopes.clear()
  unverifiedScopes.clear()
  lastSavedAt = 0
}

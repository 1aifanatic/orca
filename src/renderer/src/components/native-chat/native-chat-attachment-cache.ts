// A composer's attachments, per pane scope, owned here rather than by the composer: chips that
// are settled and chips still on their way (a save, an upload, a server's answer). A prompt card
// unmounts the composer, so anything owed to the message must outlive it: the composer that comes
// back reads the same chips, Send waits for the same pending ones, and each pending chip settles
// here whichever composer, if any, is showing. Every pending chip dies with its operation: settled
// or dropped when the save or upload settles (each bounded by its call timeout), or removed by the
// user. Mirrors the draft cache.

import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const EMPTY: readonly NativeChatComposerImageAttachment[] = Object.freeze([])
const attachmentCache = new Map<string, readonly NativeChatComposerImageAttachment[]>()
const listeners = new Map<string, Set<() => void>>()

/** The scope's chips; the same array until they change, so a reader can subscribe to it. */
export function nativeChatAttachmentSnapshot(
  scopeKey: string
): readonly NativeChatComposerImageAttachment[] {
  return attachmentCache.get(scopeKey) ?? EMPTY
}

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return [...nativeChatAttachmentSnapshot(scopeKey)]
}

/** Replaces the scope's chips and tells every composer showing them. */
export function updateNativeChatAttachmentCache(
  scopeKey: string,
  updater: (
    previous: readonly NativeChatComposerImageAttachment[]
  ) => readonly NativeChatComposerImageAttachment[]
): void {
  // Preview URLs can retain the full clipboard Blob (or a large data URL) for the lifetime of the
  // scope cache; a composer keeps its own and a chip reloads from its path.
  const next = updater(nativeChatAttachmentSnapshot(scopeKey)).map(
    ({ previewUrl: _previewUrl, ...attachment }) => attachment
  )
  if (next.length === 0) {
    attachmentCache.delete(scopeKey)
  } else {
    // LRU-bounded so attachments for permanently-removed panes can't accumulate. A scope a composer
    // shows or an attachment is still on its way to is never evicted: this is where they live.
    setBoundedScopeCacheEntry(attachmentCache, scopeKey, next, scopeInUse)
  }
  listeners.get(scopeKey)?.forEach((listener) => listener())
}

export function subscribeToNativeChatAttachmentCache(
  scopeKey: string,
  listener: () => void
): () => void {
  const scoped = listeners.get(scopeKey) ?? new Set()
  listeners.set(scopeKey, scoped)
  scoped.add(listener)
  return () => {
    scoped.delete(listener)
    if (scoped.size === 0 && listeners.get(scopeKey) === scoped) {
      listeners.delete(scopeKey)
    }
  }
}

/** Puts settled images back after whatever is attached, and shows them in a mounted composer. */
export function appendNativeChatAttachmentCache(
  scopeKey: string,
  appended: readonly NativeChatComposerImageAttachment[]
): void {
  if (appended.length > 0) {
    updateNativeChatAttachmentCache(scopeKey, (previous) => [...previous, ...appended])
  }
}

function scopeInUse(scopeKey: string): boolean {
  return (
    (listeners.get(scopeKey)?.size ?? 0) > 0 ||
    nativeChatAttachmentSnapshot(scopeKey).some((attachment) => attachment.pending === true)
  )
}

function hasPending(scopeKey: string, id: string): boolean {
  return nativeChatAttachmentSnapshot(scopeKey).some(
    (attachment) => attachment.id === id && attachment.pending === true
  )
}

/** Settles a pending chip at its path. False when the user already removed it. */
export function resolveNativeChatPendingAttachment(
  scopeKey: string,
  id: string,
  path: string,
  connectionId?: string | null
): boolean {
  if (!hasPending(scopeKey, id)) {
    return false
  }
  updateNativeChatAttachmentCache(scopeKey, (previous) =>
    previous.map((attachment) => {
      if (attachment.id !== id) {
        return attachment
      }
      const { pending: _pending, pendingName: _name, hidden: _hidden, ...settled } = attachment
      return { ...settled, path, ...(connectionId ? { connectionId } : {}) }
    })
  )
  return true
}

/** Shows a pending chip that was held out of sight, such as while a server was asked first. */
export function revealNativeChatPendingAttachment(scopeKey: string, id: string): void {
  if (hasPending(scopeKey, id)) {
    updateNativeChatAttachmentCache(scopeKey, (previous) =>
      previous.map((attachment) => {
        const { hidden: _hidden, ...shown } = attachment
        return attachment.id === id ? shown : attachment
      })
    )
  }
}

/** Removes a pending chip whose operation ended without a file. False when it was already gone. */
export function dropNativeChatPendingAttachment(scopeKey: string, id: string): boolean {
  if (!hasPending(scopeKey, id)) {
    return false
  }
  updateNativeChatAttachmentCache(scopeKey, (previous) =>
    previous.filter((attachment) => attachment.id !== id)
  )
  return true
}

export function clearNativeChatAttachmentCacheForTests(): void {
  attachmentCache.clear()
}

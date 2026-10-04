// What a send checks about attachments uploaded into a paired server's store: each one was stored
// for one server and one chat, so a composer whose chat now runs elsewhere must not send it.

import type { NativeChatAttachmentHostOwner } from './native-chat-attachment-upload'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { nativeChatAttachmentHostOwnerMatches } from './native-chat-resolved-path-ownership'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

/** An `@path` a stored non-image upload put into the draft. */
export type NativeChatHostOwnedReference = {
  reference: string
  hostOwner: NativeChatAttachmentHostOwner
}

/** Where a send goes: the chat's server, pairing and id, or null for a chat on this machine. */
export type NativeChatAttachmentDestination = {
  environmentId: string
  /** Undefined once the server is no longer paired: nothing stored for it can match. */
  pairingRevision: number | undefined
  sessionId: string
} | null

// Per composer scope, like the draft the references sit in, so they survive the same remounts.
const referenceCache = new Map<string, NativeChatHostOwnedReference[]>()

export function recordNativeChatHostOwnedReferences(
  scopeKey: string,
  references: readonly NativeChatHostOwnedReference[]
): void {
  if (references.length === 0) {
    return
  }
  setBoundedScopeCacheEntry(referenceCache, scopeKey, [
    ...(referenceCache.get(scopeKey) ?? []),
    ...references
  ])
}

export function readNativeChatHostOwnedReferences(
  scopeKey: string
): readonly NativeChatHostOwnedReference[] {
  return referenceCache.get(scopeKey) ?? []
}

export function clearNativeChatHostOwnedReferences(scopeKey: string): void {
  referenceCache.delete(scopeKey)
}

function ownerFitsDestination(
  hostOwner: NativeChatAttachmentHostOwner,
  destination: NativeChatAttachmentDestination
): boolean {
  return (
    destination !== null &&
    destination.pairingRevision !== undefined &&
    nativeChatAttachmentHostOwnerMatches(hostOwner, {
      environmentId: destination.environmentId,
      pairingRevision: destination.pairingRevision,
      sessionId: destination.sessionId
    })
  )
}

/** Stored attachments a send to `destination` must not carry. Attachments with no store owner
 *  (this machine's files, SSH uploads, workspace files) keep the checks they already have. */
export function nativeChatAttachmentsForeignToDestination(args: {
  chips: readonly NativeChatComposerImageAttachment[]
  references: readonly NativeChatHostOwnedReference[]
  draft: string
  destination: NativeChatAttachmentDestination
}): { chipIds: string[]; references: string[] } {
  return {
    chipIds: args.chips
      .filter((chip) => chip.hostOwner && !ownerFitsDestination(chip.hostOwner, args.destination))
      .map((chip) => chip.id),
    references: args.references
      .filter(
        ({ reference, hostOwner }) =>
          args.draft.includes(reference) && !ownerFitsDestination(hostOwner, args.destination)
      )
      .map(({ reference }) => reference)
  }
}

/** The draft without these references, including the space inserted after each. */
export function stripNativeChatFileReferences(
  draft: string,
  references: readonly string[]
): string {
  let next = draft
  for (const reference of references) {
    next = next.split(`${reference} `).join('').split(reference).join('')
  }
  return next
}

export function clearNativeChatHostOwnedReferencesForTests(): void {
  referenceCache.clear()
}

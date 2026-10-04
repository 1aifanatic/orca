import { useSyncExternalStore } from 'react'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'
import type { BrowserPageAnnotation } from '../../../shared/browser-grab-types'
import { structuredAgentSessionOutboxHoldsNote } from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  structuredAgentSessionCarriedNotesVersion,
  subscribeToStructuredAgentSessionCarriedNotes
} from '@/components/native-chat/structured-agent-session-outbox-carried-notes'

// Why: notes handed to a send leave the next send at once and come back only if that send fails,
// as a submitted composer clears and restores on error. A chat's saved message carries its notes'
// keys, so those stay out while this client holds that message, reload included, and are cleared
// once the host has it (notes-sent-by-chat). Other sends hold them in memory until their result.
const holds = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0

/** What a notes send gives its route: the keys a chat saves with its message, and the in-memory
 *  hold for the send's own result. */
export type NotesSendHandOff = {
  carriedNoteKeys: readonly string[]
  handOff: (delivered: Promise<unknown>) => void
}

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Takes `keys` out of the next send until `delivered` settles, whatever its result. */
export function holdNotesForSend(keys: readonly string[], delivered: Promise<unknown>): void {
  if (keys.length === 0) {
    return
  }
  for (const key of keys) {
    holds.set(key, (holds.get(key) ?? 0) + 1)
  }
  changed()
  const release = (): void => {
    for (const key of keys) {
      const count = (holds.get(key) ?? 1) - 1
      if (count > 0) {
        holds.set(key, count)
      } else {
        holds.delete(key)
      }
    }
    changed()
  }
  void delivered.then(release, release)
}

export function notesSendHandOff(keys: readonly string[]): NotesSendHandOff {
  return { carriedNoteKeys: keys, handOff: (delivered) => holdNotesForSend(keys, delivered) }
}

export function isNoteInFlight(key: string): boolean {
  return holds.has(key) || structuredAgentSessionOutboxHoldsNote(key)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const unsubscribeCarried = subscribeToStructuredAgentSessionCarriedNotes(listener)
  return () => {
    listeners.delete(listener)
    unsubscribeCarried()
  }
}

function getVersion(): number {
  return version + structuredAgentSessionCarriedNotesVersion()
}

/** Changes whenever a hold starts or ends, for memos that filter by `isNoteInFlight`. */
export function useNotesInFlightVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion)
}

/** A note's identity for delivery: an edit makes it a new pending note, as for its removal. Names
 *  its workspace, so a saved key finds its note after a reload. */
export function diffCommentSendKey(worktreeId: string, note: DiffCommentDeliverySnapshot): string {
  return JSON.stringify([
    'diff-comment',
    worktreeId,
    note.id,
    note.body,
    note.filePath,
    note.lineNumber,
    note.startLine ?? null,
    note.selectedText ?? null,
    note.source ?? null
  ])
}

/** An annotation's identity for delivery, naming its browser page. */
export function browserAnnotationSendKey(
  annotation: Pick<BrowserPageAnnotation, 'browserPageId' | 'id' | 'comment' | 'intent'>
): string {
  return JSON.stringify([
    'browser-annotation',
    annotation.browserPageId,
    annotation.id,
    annotation.comment,
    annotation.intent
  ])
}

/** Where a saved key's note lives (its workspace or browser page), or null for a key this build
 *  does not read. The note itself is found by its key. */
export function noteSendKeyOwner(
  key: string
): { kind: 'diff-comment' | 'browser-annotation'; owner: string } | null {
  try {
    const parts: unknown = JSON.parse(key)
    if (!Array.isArray(parts)) {
      return null
    }
    const [kind, owner] = parts
    return (kind === 'diff-comment' || kind === 'browser-annotation') && typeof owner === 'string'
      ? { kind, owner }
      : null
  } catch {
    return null
  }
}

export function resetNotesInFlightForTests(): void {
  holds.clear()
  changed()
}

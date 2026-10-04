import { useSyncExternalStore } from 'react'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'

// Why: notes handed to a send leave the next send at once and come back only if that delivery
// fails, as a submitted composer clears and restores on error. Delivered notes are still removed
// by their owner; a hold lives only until its delivery settles.
const holds = new Map<unknown, number>()
const listeners = new Set<() => void>()
let version = 0

function changed(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

/** Takes `keys` out of the next send until `delivered` settles, whatever its result. */
export function holdNotesForSend(keys: readonly unknown[], delivered: Promise<unknown>): void {
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

export function isNoteInFlight(key: unknown): boolean {
  return holds.has(key)
}

/** Changes whenever a hold starts or ends, for memos that filter by `isNoteInFlight`. */
export function useNotesInFlightVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
    () => version
  )
}

/** A note's identity for delivery: an edit makes it a new pending note, as for its removal. */
export function diffCommentSendKey(note: DiffCommentDeliverySnapshot): string {
  return JSON.stringify([
    note.id,
    note.body,
    note.filePath,
    note.lineNumber,
    note.startLine ?? null,
    note.selectedText ?? null,
    note.source ?? null
  ])
}

export function resetNotesInFlightForTests(): void {
  holds.clear()
  changed()
}

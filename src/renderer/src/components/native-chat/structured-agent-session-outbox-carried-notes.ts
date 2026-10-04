// Which notes a message this client still holds carries, read from the saved outboxes, never
// inferred from tabs or host syncs: a note stays off the shelf while a message in this client's
// outbox carries its key and the host can still deliver that message's id. Past the host's window
// it never can, so the hold lapses on its own.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryHostWindowEndsAt } from '../../../../shared/structured-agent-session-send-settlement'

type CarriedNote = { key: string; windowEndsAt: number }

const carriedBySession = new Map<string, readonly CarriedNote[]>()
let loaded = false
let version = 0
let lapseTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

/** setTimeout's longest delay; a later lapse is armed again when this one fires. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

function carriedNotes(entries: readonly StructuredAgentSessionOutboxEntry[]): CarriedNote[] {
  return entries.flatMap((entry) => {
    // An id with no time has no window to outlive; the message's own ending releases it.
    const windowEndsAt = structuredAgentSessionEntryHostWindowEndsAt(entry) ?? Infinity
    return (entry.carriedNoteKeys ?? []).map((key) => ({ key, windowEndsAt }))
  })
}

function changed(): void {
  version += 1
  armLapse()
  for (const listener of listeners) {
    listener()
  }
}

/** Wakes readers when the soonest hold still open lapses, though no outbox changed. */
function armLapse(): void {
  clearTimeout(lapseTimer)
  const now = Date.now()
  let soonest = Infinity
  for (const notes of carriedBySession.values()) {
    for (const note of notes) {
      if (note.windowEndsAt > now && note.windowEndsAt < soonest) {
        soonest = note.windowEndsAt
      }
    }
  }
  if (soonest !== Infinity) {
    lapseTimer = setTimeout(changed, Math.min(soonest - now + 1, MAX_TIMER_DELAY_MS))
  }
}

function setCarried(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  const next = carriedNotes(entries)
  const previous = carriedBySession.get(sessionId) ?? []
  if (next.length === 0) {
    carriedBySession.delete(sessionId)
  } else {
    carriedBySession.set(sessionId, next)
  }
  return (
    next.length !== previous.length ||
    next.some(
      (note, index) =>
        note.key !== previous[index]?.key || note.windowEndsAt !== previous[index]?.windowEndsAt
    )
  )
}

type SavedOutboxes = () => Iterable<readonly [string, StructuredAgentSessionOutboxEntry[]]>

/** Reads every saved outbox once, the first time the notes they carry are asked about. */
function load(saved: SavedOutboxes): void {
  if (loaded) {
    return
  }
  loaded = true
  for (const [sessionId, entries] of saved()) {
    setCarried(sessionId, entries)
  }
  armLapse()
}

/** Run by the outbox's one write funnel once `entries` is the session's outbox. */
export function recordStructuredAgentSessionCarriedNotes(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[],
  saved: SavedOutboxes
): void {
  load(saved)
  if (setCarried(sessionId, entries)) {
    changed()
  }
}

/** Whether a message this client holds still carries the note, inside the host's window. */
export function structuredAgentSessionOutboxCarriesNote(
  key: string,
  saved: SavedOutboxes,
  now = Date.now()
): boolean {
  load(saved)
  for (const notes of carriedBySession.values()) {
    if (notes.some((note) => note.key === key && note.windowEndsAt > now)) {
      return true
    }
  }
  return false
}

export function subscribeToStructuredAgentSessionCarriedNotes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function structuredAgentSessionCarriedNotesVersion(): number {
  return version
}

/** Forgets what was read, as a reload does: the next question reads the saved outboxes again. */
export function resetStructuredAgentSessionCarriedNotesForTests(): void {
  clearTimeout(lapseTimer)
  carriedBySession.clear()
  loaded = false
  changed()
}

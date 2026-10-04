import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

/** How a message left its chat's outbox: sent on (accepted, or handed to the host or the
 *  composer), or thrown away with the chat. */
export type StructuredAgentSessionOutboxRemoval = 'spent' | 'discarded'

// Why: the notes a chat's queued messages carry, read from the saved outboxes once and kept current
// by the outbox's one write funnel. A message's notes go when it does, so nothing here outlives it.
const carriedBySession = new Map<string, readonly string[]>()
let loaded = false
let version = 0
const changeListeners = new Set<() => void>()
const spentListeners = new Set<(keys: readonly string[]) => void>()

function carriedKeys(entries: readonly StructuredAgentSessionOutboxEntry[]): string[] {
  return entries.flatMap((entry) => entry.carriedNoteKeys ?? [])
}

function setCarried(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  const next = carriedKeys(entries)
  const previous = carriedBySession.get(sessionId) ?? []
  if (next.length === 0) {
    carriedBySession.delete(sessionId)
  } else {
    carriedBySession.set(sessionId, next)
  }
  return next.length !== previous.length || next.some((key, index) => key !== previous[index])
}

function changed(): void {
  version += 1
  for (const listener of changeListeners) {
    listener()
  }
}

/** Reads every saved outbox once, the first time the notes they carry are asked about. */
export function loadStructuredAgentSessionCarriedNotes(
  saved: () => Iterable<readonly [string, readonly StructuredAgentSessionOutboxEntry[]]>
): void {
  if (loaded) {
    return
  }
  loaded = true
  for (const [sessionId, entries] of saved()) {
    setCarried(sessionId, entries)
  }
}

// A user's Retry of a refused message gives it a new id; its text and queue time stay.
function stillQueued(
  message: StructuredAgentSessionOutboxEntry,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): boolean {
  const body = JSON.stringify(message.body)
  return entries.some(
    (entry) =>
      entry.clientMessageId === message.clientMessageId ||
      (entry.queuedAt === message.queuedAt && JSON.stringify(entry.body) === body)
  )
}

/** Run by the outbox's write funnel once `after` replaces `before` as the session's outbox. */
export function recordStructuredAgentSessionCarriedNotes(
  sessionId: string,
  before: readonly StructuredAgentSessionOutboxEntry[],
  after: readonly StructuredAgentSessionOutboxEntry[],
  removal: StructuredAgentSessionOutboxRemoval
): void {
  const spent =
    removal === 'spent' ? carriedKeys(before.filter((message) => !stillQueued(message, after))) : []
  // A spent message's notes are cleared before they could show as sendable again.
  if (spent.length > 0) {
    for (const listener of spentListeners) {
      listener(spent)
    }
  }
  if (setCarried(sessionId, after)) {
    changed()
  }
}

export function carriedNotesInclude(key: string): boolean {
  for (const keys of carriedBySession.values()) {
    if (keys.includes(key)) {
      return true
    }
  }
  return false
}

export function subscribeToStructuredAgentSessionCarriedNotes(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

export function structuredAgentSessionCarriedNotesVersion(): number {
  return version
}

/** Told the notes of every message sent on, whichever send or Retry sent it. */
export function subscribeToStructuredAgentSessionCarriedNotesSpent(
  listener: (keys: readonly string[]) => void
): () => void {
  spentListeners.add(listener)
  return () => spentListeners.delete(listener)
}

export function resetStructuredAgentSessionCarriedNotesForTests(): void {
  carriedBySession.clear()
  loaded = false
  changed()
}

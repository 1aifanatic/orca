// The unload journal: changes storage had not confirmed when a window went away, written
// synchronously to localStorage and replayed by the next load. Every window of the app shares it,
// so each entry is pruned the moment any window confirms a change to that draft.

import type { UnconfirmedDraftChange } from './native-chat-composer-draft-memory'
import { parseStoredNativeChatComposerDraft } from './native-chat-composer-draft-storage'

const JOURNAL_KEY = 'orca:nativeChatComposerDraftJournal:v1'
// Why: localStorage also holds the send outbox, and a send is refused when its entry can't be
// saved, so the journal never takes more than this.
export const MAX_JOURNAL_CHARS = 256_000

type JournalEntry = UnconfirmedDraftChange & { readonly scopeKey: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEntries(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY)
    const entries: unknown = raw === null ? [] : JSON.parse(raw)
    if (!Array.isArray(entries)) {
      return []
    }
    return entries.flatMap((entry: unknown) => {
      if (!isRecord(entry)) {
        return []
      }
      const { scopeKey, draft, at } = entry
      return typeof scopeKey === 'string' && typeof at === 'number'
        ? [{ scopeKey, draft: parseStoredNativeChatComposerDraft(draft), at }]
        : []
    })
  } catch {
    return []
  }
}

function writeEntries(entries: readonly JournalEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(JOURNAL_KEY)
      return
    }
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(entries))
  } catch {
    // A full localStorage loses only what storage itself had not yet confirmed.
  }
}

export function readNativeChatComposerDraftJournal(): Map<string, UnconfirmedDraftChange> {
  return new Map(readEntries().map(({ scopeKey, draft, at }) => [scopeKey, { draft, at }]))
}

/** Adds this window's unconfirmed changes, keeping other windows' entries, within the cap. An
 *  entry that doesn't fit is left out; its change was still issued to storage. */
export function journalNativeChatComposerDraftChanges(
  changes: ReadonlyMap<string, UnconfirmedDraftChange>
): void {
  if (changes.size === 0) {
    return
  }
  const kept = readEntries().filter((entry) => !changes.has(entry.scopeKey))
  let used = JSON.stringify(kept).length
  const added: JournalEntry[] = []
  const bySize = [...changes]
    .map(([scopeKey, change]) => ({ scopeKey, ...change }))
    .map((entry) => ({ entry, size: JSON.stringify(entry).length + 1 }))
    .sort((left, right) => left.size - right.size)
  for (const { entry, size } of bySize) {
    if (used + size > MAX_JOURNAL_CHARS) {
      break
    }
    added.push(entry)
    used += size
  }
  if (added.length > 0) {
    writeEntries([...kept, ...added])
  }
}

/** Drops a draft's entry once a change to it at least as new is confirmed, by any window, so a
 *  replay never brings back what was sent or replaced since. */
export function pruneNativeChatComposerDraftJournal(scopeKey: string, confirmedAt: number): void {
  try {
    if (localStorage.getItem(JOURNAL_KEY) === null) {
      return
    }
  } catch {
    return
  }
  const entries = readEntries()
  const kept = entries.filter((entry) => entry.scopeKey !== scopeKey || entry.at > confirmedAt)
  if (kept.length !== entries.length) {
    writeEntries(kept)
  }
}

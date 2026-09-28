// A per-chat file that reappears after its chat was copied in: an older build, run after a
// downgrade, attached the chat and wrote its history there. A file that carried the chat's
// history on is the newer history. One the older build started from nothing, since the copy's
// delete left it no file, holds none of this build's history: it stays on disk as it is, and never
// replaces that history. That is decided once and recorded in `journal_set_aside`, and the file is
// never opened again: whatever an older build writes there later grows from its own start.
//
// `journal_imports` records which file each chat was copied from — its epoch and tip — in the
// transaction that publishes the verified copy, so a file already copied (only its delete failed,
// or a crash came first, across any number of restarts) is deleted, never copied again, and a
// file that carried the history on always is. Newest writer wins, per chat, and the chat says so.
// When both builds advanced one epoch from the recorded tip, the copy takes a fresh epoch, so every
// reader resets instead of silently skipping rows.

import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { boundJournalStatusText } from './journal-prompt-body-bounds'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow } from './journal-row-builders'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'
import { readJournalTip, type JournalBlockPointer } from './journal-row-table'
import type { LegacyJournalHead } from './journal-per-session-source'

export type PerSessionJournalHead = { epoch: string; tip: number }

const SELECT_MARKER = 'SELECT epoch, tip FROM journal_imports WHERE session_id = ?'
const UPSERT_MARKER = `INSERT INTO journal_imports (session_id, epoch, tip) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, tip = excluded.tip`

export const JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY = {
  provider: 'orca',
  clientMessageId: 'journal-continued-in-older-orca'
} as const

const OLDER_BUILD_DISCLOSURE =
  'This chat was continued in an older version of Orca. Its history now comes from that version; anything this version recorded before then was replaced.'

export function readPerSessionImportMarker(
  db: Database.Database,
  sessionId: string
): PerSessionJournalHead | null {
  const row = db.prepare(SELECT_MARKER).get(sessionId)
  return typeof row?.epoch === 'string' && typeof row.tip === 'number'
    ? { epoch: row.epoch, tip: row.tip }
    : null
}

const SELECT_SET_ASIDE = 'SELECT 1 AS present FROM journal_set_aside WHERE session_id = ?'
const INSERT_SET_ASIDE = `INSERT INTO journal_set_aside (session_id, epoch, tip) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO NOTHING`

export function isPerSessionJournalSetAside(db: Database.Database, sessionId: string): boolean {
  return db.prepare(SELECT_SET_ASIDE).get(sessionId) !== undefined
}

/** Records the file an older build started over, as it was when set aside. */
export function setAsidePerSessionJournal(
  db: Database.Database,
  sessionId: string,
  head: PerSessionJournalHead
): void {
  db.prepare(INSERT_SET_ASIDE).run(sessionId, head.epoch, head.tip)
}

export function writePerSessionImportMarker(
  db: Database.Database,
  sessionId: string,
  head: PerSessionJournalHead
): void {
  db.prepare(UPSERT_MARKER).run(sessionId, head.epoch, head.tip)
}

export type PerSessionImportPlan =
  | { kind: 'first' }
  | { kind: 'copied' }
  /** An older build started the file from nothing: set aside, neither copied nor deleted. */
  | { kind: 'kept' }
  /** The file is newer history: copied again, as `epoch`, with a row saying so. */
  | { kind: 'again'; epoch: string }

/** What a present per-chat file owes this chat, judged against what was last copied from it. */
export function planPerSessionImport(input: {
  db: Database.Database
  sessionId: string
  legacy: LegacyJournalHead
  current: JournalBlockPointer | null
}): PerSessionImportPlan {
  const marker = readPerSessionImportMarker(input.db, input.sessionId)
  if (marker?.epoch === input.legacy.epoch && marker.tip === input.legacy.tip) {
    return { kind: 'copied' }
  }
  if (!marker && !input.current) {
    return { kind: 'first' }
  }
  // This build holds the chat (a pointer or a marker), so a file an older build started from
  // nothing is not its history: copying it would replace everything this build has.
  if (input.legacy.startedFresh && input.legacy.epoch !== marker?.epoch) {
    return { kind: 'kept' }
  }
  // Both sides wrote past the recorded tip under one epoch: replacing it in place would leave a
  // reader at this build's tip skipping the older build's rows.
  const bothAdvanced =
    marker !== null &&
    input.current?.epoch === marker.epoch &&
    input.legacy.epoch === marker.epoch &&
    input.legacy.tip > marker.tip &&
    readJournalTip(input.db, input.current.block) > marker.tip
  return { kind: 'again', epoch: bothAdvanced ? randomUUID() : input.legacy.epoch }
}

/**
 * The rows a second copy writes: the file's rows under `epoch` — byte-identical when the epoch is
 * the file's own — then the row that says the chat continued in an older Orca.
 */
export function reimportedJournalRows(input: {
  sessionId: string
  legacyEpoch: string
  epoch: string
  rows: readonly { seq: number; ts: number; rowJson: string }[]
  now: number
}): { seq: number; ts: number; rowJson: string }[] {
  const state = createJournalReducerState(input.sessionId, input.epoch)
  const copied = input.rows.map((stored) => {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      throw new Error(`per-chat journal row ${stored.seq} of ${input.sessionId} is unreadable`)
    }
    const row: JournalRow =
      input.epoch === input.legacyEpoch ? parsed.row : { ...parsed.row, epoch: input.epoch }
    applyJournalRow(state, row)
    return input.epoch === input.legacyEpoch
      ? stored
      : { seq: stored.seq, ts: stored.ts, rowJson: serializeJournalRow(row) }
  })
  const disclosure = buildJournalItemRow({
    state,
    identity: JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY,
    body: { kind: 'status', text: boundJournalStatusText(OLDER_BUILD_DISCLOSURE) },
    seq: state.lastSequence + 1,
    fence: state.highestFence,
    ts: input.now
  })
  return [
    ...copied,
    { seq: disclosure.seq, ts: disclosure.ts, rowJson: serializeJournalRow(disclosure) }
  ]
}

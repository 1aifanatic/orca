// A per-chat file that reappears after its chat was copied in: an older build, run after a
// downgrade, attached the chat and wrote its history there.
//
// `journal_imports` records which file each chat was copied from — its epoch and tip — in the
// transaction that publishes the verified copy. A file still at that epoch and tip was already
// copied (only its delete failed, or a crash came first, across any number of restarts): it is
// deleted, never copied again. A file at that epoch past it carried the copied history on, and
// while this build's history still stands exactly as copied, the file is that history plus the
// older build's rows: it is copied again, and the chat says so.
//
// Anything else would replace history this build holds: a file at any other epoch, or beside a
// chat this build founded itself, never held it (an older build started it over, or rolled the
// epoch of a file it kept); and once this build has written past the copy, or rolled its own
// epoch, the file no longer carries what this build has. Such a file is set aside, left on disk as
// it is, and recorded in `journal_set_aside`, so no later open reads it again.

import type Database from '../../sqlite/sync-database'
import { boundJournalStatusText } from './journal-prompt-body-bounds'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow } from './journal-row-builders'
import { parseJournalRow, serializeJournalRow } from './journal-row-schema'
import { readJournalTip, type JournalBlockPointer } from './journal-row-table'

export type PerSessionJournalHead = { epoch: string; tip: number }

const SELECT_MARKER = 'SELECT epoch, tip FROM journal_imports WHERE session_id = ?'
const UPSERT_MARKER = `INSERT INTO journal_imports (session_id, epoch, tip) VALUES (?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET epoch = excluded.epoch, tip = excluded.tip`

export const JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY = {
  provider: 'orca',
  clientMessageId: 'journal-continued-in-older-orca'
} as const

const OLDER_BUILD_DISCLOSURE =
  'This chat was continued in an older version of Orca. Its history includes what was recorded there.'

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

/** Records a file that is not this build's history, as it was when set aside. */
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
  /** Not this build's history: set aside, neither copied nor deleted. */
  | { kind: 'kept' }
  /** The copied history carried on: copied again, with a row saying so. */
  | { kind: 'again' }

/** What a present per-chat file owes this chat, judged against what was last copied from it. */
export function planPerSessionImport(input: {
  db: Database.Database
  sessionId: string
  legacy: PerSessionJournalHead
  current: JournalBlockPointer | null
}): PerSessionImportPlan {
  const marker = readPerSessionImportMarker(input.db, input.sessionId)
  if (marker?.epoch === input.legacy.epoch && marker.tip === input.legacy.tip) {
    return { kind: 'copied' }
  }
  if (!marker && !input.current) {
    return { kind: 'first' }
  }
  // Copied again only while this build's history is exactly what was copied: past that, the copy
  // would replace rows this build wrote.
  const continued =
    marker !== null &&
    input.legacy.epoch === marker.epoch &&
    input.current?.epoch === marker.epoch &&
    readJournalTip(input.db, input.current.block) === marker.tip
  return continued ? { kind: 'again' } : { kind: 'kept' }
}

/** The rows a second copy writes: the file's rows as stored, then the row that says the chat
 *  continued in an older Orca. */
export function reimportedJournalRows(input: {
  sessionId: string
  epoch: string
  rows: readonly { seq: number; ts: number; rowJson: string }[]
  now: number
}): { seq: number; ts: number; rowJson: string }[] {
  const state = createJournalReducerState(input.sessionId, input.epoch)
  for (const stored of input.rows) {
    const parsed = parseJournalRow(stored.rowJson)
    if (!parsed.ok) {
      throw new Error(`per-chat journal row ${stored.seq} of ${input.sessionId} is unreadable`)
    }
    applyJournalRow(state, parsed.row)
  }
  const disclosure = buildJournalItemRow({
    state,
    identity: JOURNAL_OLDER_BUILD_DISCLOSURE_IDENTITY,
    body: { kind: 'status', text: boundJournalStatusText(OLDER_BUILD_DISCLOSURE) },
    seq: state.lastSequence + 1,
    fence: state.highestFence,
    ts: input.now
  })
  return [
    ...input.rows,
    { seq: disclosure.seq, ts: disclosure.ts, rowJson: serializeJournalRow(disclosure) }
  ]
}

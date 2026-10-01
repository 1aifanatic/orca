// Each chat's lifecycle state, stored beside its journal.
//
// One row per chat: whether its next open owes settlement work (see
// journal-open-settlement-plan.ts), and the status summary a session list shows. Written right
// after the journal commit it describes, in its own transaction, and trusted only while its
// `(epoch, seq)` is the chat's live tip, so a write that failed, was lost, or was never made (an
// older build's append) reads as stale and the chat is re-derived. Deleting a row is always safe for
// the same reason.
//
// Created at every writable open with no `user_version` bump, as the draft table is
// (queued-message-schema.ts): an older build ignores it and stays writable.

import type Database from '../../sqlite/sync-database'
import { isAgentTurnOutcome } from '../../../shared/agent-turn-outcome'
import {
  projectStructuredAgentSessionStatusState,
  type StructuredAgentSessionStatusProjection
} from '../../../shared/structured-agent-session-projection'
import { owesOpenSettlement, type JournalOwedFacts } from './journal-open-settlement-plan'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

/** Version of the rules that derive a row. A row of another version reads as absent. Bump it with
 *  any change to what `deriveJournalSessionState` produces; the golden test pins it. */
export const JOURNAL_SESSION_STATE_VERSION = 2

export function ensureJournalSessionStateTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_session_state (
  session_id                TEXT    PRIMARY KEY,
  state_version             INTEGER NOT NULL,
  epoch                     TEXT    NOT NULL,
  seq                       INTEGER NOT NULL,
  owes_work                 INTEGER NOT NULL,
  unverifiable_owner_fences TEXT,
  summary_json              TEXT,
  last_activity_at          INTEGER NOT NULL,
  written_at                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_session_state_owed
  ON journal_session_state (session_id)
  WHERE owes_work = 1 OR unverifiable_owner_fences IS NOT NULL;
`)
}

export type DerivedJournalSessionState = JournalOwedFacts & {
  epoch: string
  seq: number
  /** Only while nothing is owed: an owing chat is settled and republished by its open. */
  summary: StructuredAgentSessionStatusProjection | null
  lastActivityAt: number
}

export type StoredJournalSessionState = DerivedJournalSessionState & {
  stateVersion: number
  writtenAt: number
}

export type JournalSessionStateInput = {
  /** False while the chat's load is corrupt: its open settles no roster either. */
  settlesRosters: boolean
  currentFence?: number
  /** The fold's status summary, when the caller already projected this tip. */
  statusSummary?: () => StructuredAgentSessionStatusProjection
}

export function deriveJournalSessionState(
  state: JournalReducerState,
  input: JournalSessionStateInput
): DerivedJournalSessionState {
  const facts = owesOpenSettlement(state, input)
  let summary: StructuredAgentSessionStatusProjection | null = null
  if (!facts.owesWork) {
    // Fence-independent here: nothing unanswered or queued is left for the fence to judge.
    summary = input.statusSummary
      ? input.statusSummary()
      : projectSummary(state, input.currentFence)
  }
  return {
    ...facts,
    epoch: state.epoch,
    seq: state.lastSequence,
    summary,
    lastActivityAt: state.lastActivityAt
  }
}

function projectSummary(
  state: JournalReducerState,
  fence: number | undefined
): StructuredAgentSessionStatusProjection {
  const snapshot = renderJournalState(state)
  return projectStructuredAgentSessionStatusState(snapshot.items, snapshot.submissions, fence)
    .summary
}

const UPSERT_STATE = `INSERT INTO journal_session_state (session_id, state_version, epoch, seq,
  owes_work, unverifiable_owner_fences, summary_json, last_activity_at, written_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  state_version = excluded.state_version, epoch = excluded.epoch, seq = excluded.seq,
  owes_work = excluded.owes_work, unverifiable_owner_fences = excluded.unverifiable_owner_fences,
  summary_json = excluded.summary_json, last_activity_at = excluded.last_activity_at,
  written_at = excluded.written_at`
const DELETE_STATE = 'DELETE FROM journal_session_state WHERE session_id = ?'
const STATE_COLUMNS = `st.state_version AS state_version, st.epoch AS state_epoch, st.seq AS seq,
  st.owes_work AS owes_work, st.unverifiable_owner_fences AS unverifiable_owner_fences,
  st.summary_json AS summary_json, st.last_activity_at AS last_activity_at,
  st.written_at AS written_at`
const SELECT_STATE = `SELECT ${STATE_COLUMNS} FROM journal_session_state st WHERE st.session_id = ?`

export function writeJournalSessionState(
  db: Database.Database,
  sessionId: string,
  derived: DerivedJournalSessionState,
  writtenAt: number
): void {
  db.prepare(UPSERT_STATE).run(
    sessionId,
    JOURNAL_SESSION_STATE_VERSION,
    derived.epoch,
    derived.seq,
    derived.owesWork ? 1 : 0,
    derived.unverifiableOwnerFences.length > 0
      ? JSON.stringify(derived.unverifiableOwnerFences)
      : null,
    derived.summary ? JSON.stringify(derived.summary) : null,
    derived.lastActivityAt,
    writtenAt
  )
}

export function deleteJournalSessionState(db: Database.Database, sessionId: string): void {
  db.prepare(DELETE_STATE).run(sessionId)
}

/** This build's row for the chat, or null when there is none or another version wrote it. */
export function readJournalSessionState(
  db: Database.Database,
  sessionId: string
): StoredJournalSessionState | null {
  const row = db.prepare(SELECT_STATE).get(sessionId)
  return row ? parseStoredState(row) : null
}

/** A chat's stored state beside its live tip, for the startup seed. */
export type JournalSessionStateAtTip = {
  sessionId: string
  /** Null when absent, of another version, behind the tip, or older than a repair. */
  current: StoredJournalSessionState | null
}

// Bounded well under SQLite's host-parameter limit.
const IN_LIST_CHUNK = 500

/** One query per chunk of ids; ids with no journal yet are not returned. */
export function readJournalSessionStatesAtTip(
  db: Database.Database,
  sessionIds: readonly string[]
): JournalSessionStateAtTip[] {
  const results: JournalSessionStateAtTip[] = []
  for (let start = 0; start < sessionIds.length; start += IN_LIST_CHUNK) {
    const chunk = sessionIds.slice(start, start + IN_LIST_CHUNK)
    const rows = db
      .prepare(
        `SELECT s.session_id AS session_id, s.epoch AS live_epoch,
  (SELECT MAX(r.seq) FROM journal_rows r
    WHERE r.session_id = s.session_id AND r.epoch = s.epoch) AS tip,
  (SELECT p.repaired_at FROM journal_repairs p
    WHERE p.session_id = s.session_id AND p.epoch = s.epoch) AS repaired_at,
  ${STATE_COLUMNS}
FROM journal_sessions s LEFT JOIN journal_session_state st ON st.session_id = s.session_id
WHERE s.session_id IN (${chunk.map(() => '?').join(', ')})`
      )
      .all(...chunk)
    for (const row of rows) {
      if (typeof row.session_id !== 'string') {
        continue
      }
      const stored = parseStoredState(row)
      const atTip =
        stored !== null &&
        stored.epoch === row.live_epoch &&
        stored.seq === row.tip &&
        (typeof row.repaired_at !== 'number' || row.repaired_at <= stored.writtenAt)
      results.push({ sessionId: row.session_id, current: atTip ? stored : null })
    }
  }
  return results
}

/**
 * Every chat this build's rows say may owe work at open, through the partial index, at any position:
 * a row one write behind its tip (a write that failed, or a kill between the two commits) still
 * owes what it owed, since a turn running then is still running, and an open that finds nothing to
 * settle appends nothing. A row that owes nothing is never selected, stale or not, so no boot opens
 * a settled chat: its own open re-derives it.
 */
export function readOwedJournalSessionStates(
  db: Database.Database
): (JournalOwedFacts & { sessionId: string })[] {
  return db
    .prepare(
      `SELECT session_id, owes_work, unverifiable_owner_fences FROM journal_session_state
WHERE (owes_work = 1 OR unverifiable_owner_fences IS NOT NULL) AND state_version = ?`
    )
    .all(JOURNAL_SESSION_STATE_VERSION)
    .flatMap((row) =>
      typeof row.session_id === 'string'
        ? [
            {
              sessionId: row.session_id,
              owesWork: row.owes_work === 1,
              unverifiableOwnerFences: parseFences(row.unverifiable_owner_fences)
            }
          ]
        : []
    )
}

function parseStoredState(row: Record<string, unknown>): StoredJournalSessionState | null {
  if (
    row.state_version !== JOURNAL_SESSION_STATE_VERSION ||
    typeof row.state_epoch !== 'string' ||
    typeof row.seq !== 'number' ||
    typeof row.last_activity_at !== 'number' ||
    typeof row.written_at !== 'number'
  ) {
    return null
  }
  const owesWork = row.owes_work === 1
  const summary = owesWork ? null : parseSummary(row.summary_json)
  if (!owesWork && !summary) {
    return null
  }
  return {
    stateVersion: JOURNAL_SESSION_STATE_VERSION,
    epoch: row.state_epoch,
    seq: row.seq,
    owesWork,
    unverifiableOwnerFences: parseFences(row.unverifiable_owner_fences),
    summary,
    lastActivityAt: row.last_activity_at,
    writtenAt: row.written_at
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function parseFences(value: unknown): number[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed)
    ? parsed.filter((fence): fence is number => Number.isSafeInteger(fence))
    : []
}

const STATUSES = ['idle', 'working', 'attention'] as const

function parseStatus(value: unknown): StructuredAgentSessionStatusProjection['status'] | undefined {
  return value === null ? null : STATUSES.find((status) => status === value)
}

/** Known keys only: a newer writer's extra keys are ignored rather than trusted. */
function parseSummary(value: unknown): StructuredAgentSessionStatusProjection | null {
  const parsed = parseJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const source = new Map(Object.entries(parsed))
  const status = parseStatus(source.get('status'))
  const latestPrompt = source.get('latestPrompt')
  if (status === undefined || typeof latestPrompt !== 'string') {
    return null
  }
  const text = (key: string): string | undefined => {
    const field = source.get(key)
    return typeof field === 'string' ? field : undefined
  }
  const turnOutcome = source.get('turnOutcome')
  if (turnOutcome !== undefined && !isAgentTurnOutcome(turnOutcome)) {
    // A verdict this build cannot show: stale, so the chat's open publishes it rather than a
    // row without it.
    return null
  }
  const statusStartedAt = source.get('statusStartedAt')
  const toolName = text('toolName')
  const toolInput = text('toolInput')
  const lastAssistantMessage = text('lastAssistantMessage')
  return {
    status,
    latestPrompt,
    ...(toolName !== undefined ? { toolName } : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
    ...(isAgentTurnOutcome(turnOutcome) ? { turnOutcome } : {}),
    ...(typeof statusStartedAt === 'number' ? { statusStartedAt } : {})
  }
}

/**
 * The open's re-derive: rewrites the chat's row when it is absent, another version's, off the
 * fold's tip, or older than a repair. What an older build, an import, a repair or a failed or lost
 * write left behind is caught here. Bookkeeping: the caller logs a failure and goes on.
 */
export function ensureJournalSessionStateCurrent(
  db: Database.Database,
  state: JournalReducerState,
  input: JournalSessionStateInput,
  now: number
): boolean {
  const [stored] = readJournalSessionStatesAtTip(db, [state.sessionId])
  if (stored?.current?.epoch === state.epoch && stored.current.seq === state.lastSequence) {
    return false
  }
  writeJournalSessionState(db, state.sessionId, deriveJournalSessionState(state, input), now)
  return true
}

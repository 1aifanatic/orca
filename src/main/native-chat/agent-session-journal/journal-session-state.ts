// Each chat's status, stored beside its journal.
//
// One row per chat, written in the SAME transaction as every journal write that changes the chat,
// from the fold that write produces: whether work is running or a prompt is waiting, which sends
// were handed over and never answered or are still queued, live child work, and the status summary
// a session list shows. A failed status write fails the write it describes, so a row is always the
// chat's current state. Startup selects the chats a gone process left with work from these rows,
// and seeds every other chat's status from them.
//
// The table needs no schema version: an older build opens the database as before, ignores the table,
// and can append history without a status. So each row records the history tip it was derived from
// and the rules it was derived by, and a row whose tip is not the chat's tip now, or whose rules are
// other, reads as missing: it is derived again exactly as a chat with no row is, when the chat opens
// (a listed one in the background restore after the listing).

import type Database from '../../sqlite/sync-database'
import { isAgentTurnOutcome } from '../../../shared/agent-turn-outcome'
import {
  projectStructuredAgentSessionStatusState,
  type StructuredAgentSessionStatusProjection
} from '../../../shared/structured-agent-session-projection'
import { journalSettlementFacts } from './journal-open-settlement-plan'
import { renderJournalState, type JournalReducerState } from './journal-reducer'

/** What the stored status is derived by: the derivation below and the shared projection it reads.
 *  Bump it with any change to what either produces for the same journal; the corpus digest test
 *  fails until it is bumped. */
export const JOURNAL_SESSION_STATUS_RULES = 3

/** Work a gone process can have left: running work, a waiting prompt, unanswered or queued sends,
 *  or live child work. Startup settles exactly these chats. */
const UNSETTLED = `lifecycle <> 'idle' OR handed_over_sends > 0 OR queued_sends > 0 OR live_child_work = 1`

/** A row whose recorded tip is still the chat's tip: no row was written past it or in its place.
 *  `st` is the status row; each check is one primary-key lookup on `journal_rows`. */
const AT_TIP = `EXISTS (SELECT 1 FROM journal_sessions live JOIN journal_rows tip
    ON tip.session_id = live.session_id AND tip.epoch = live.epoch AND tip.seq = st.tip_seq
    WHERE live.session_id = st.session_id AND live.epoch = st.epoch AND tip.ts = st.tip_ts)
  AND NOT EXISTS (SELECT 1 FROM journal_rows later WHERE later.session_id = st.session_id
    AND later.epoch = st.epoch AND later.seq > st.tip_seq)`

/** Created idempotently at every writable open, with no `user_version` bump, as
 *  `ensureQueuedMessagesTable` is: an older build stays writable and ignores it. */
export function ensureJournalSessionStatusTable(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS journal_session_state (
  session_id        TEXT    PRIMARY KEY,
  lifecycle         TEXT    NOT NULL,
  active_turn_id    TEXT,
  handed_over_sends INTEGER NOT NULL,
  queued_sends      INTEGER NOT NULL,
  live_child_work   INTEGER NOT NULL,
  summary_json      TEXT    NOT NULL,
  last_activity_at  INTEGER NOT NULL,
  rules_version     INTEGER NOT NULL,
  epoch             TEXT    NOT NULL,
  tip_seq           INTEGER NOT NULL,
  tip_ts            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_session_state_unsettled ON journal_session_state (session_id)
  WHERE ${UNSETTLED};
`)
}

export type JournalSessionStatus = {
  /** What a settle would revise: work still running (a starting turn included: the journal records
   *  no separate start) or a prompt waiting. Not the status a session list shows, which is
   *  `summary.status`: that follows the newest turn and counts unanswered sends as working. */
  lifecycle: 'idle' | 'running' | 'attention'
  activeTurnId: string | null
  handedOverSends: number
  queuedSends: number
  liveChildWork: boolean
  summary: StructuredAgentSessionStatusProjection
  lastActivityAt: number
}

export type JournalSessionStatusInput = {
  currentFence?: number
  /** The fold's status summary, when the caller already projects this tip. */
  statusSummary?: () => StructuredAgentSessionStatusProjection
}

export function deriveJournalSessionStatus(
  state: JournalReducerState,
  input: JournalSessionStatusInput = {}
): JournalSessionStatus {
  const facts = journalSettlementFacts(state)
  return {
    lifecycle: facts.runningWork ? 'running' : facts.pendingPrompts ? 'attention' : 'idle',
    activeTurnId: facts.activeTurnId,
    handedOverSends: facts.handedOverSends,
    queuedSends: facts.queuedSends,
    liveChildWork: facts.liveChildWork,
    summary: input.statusSummary
      ? input.statusSummary()
      : projectSummary(state, input.currentFence),
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

export function isUnsettledJournalSessionStatus(status: JournalSessionStatus): boolean {
  return (
    status.lifecycle !== 'idle' ||
    status.handedOverSends > 0 ||
    status.queuedSends > 0 ||
    status.liveChildWork
  )
}

// The tip is read inside the statement, so a row always records the history it was written with.
const UPSERT_STATUS = `INSERT INTO journal_session_state (session_id, lifecycle, active_turn_id,
  handed_over_sends, queued_sends, live_child_work, summary_json, last_activity_at, rules_version,
  epoch, tip_seq, tip_ts)
SELECT s.session_id, ?, ?, ?, ?, ?, ?, ?, ?, s.epoch, r.seq, r.ts
FROM journal_sessions s JOIN journal_rows r ON r.session_id = s.session_id AND r.epoch = s.epoch
WHERE s.session_id = ? ORDER BY r.seq DESC LIMIT 1
ON CONFLICT(session_id) DO UPDATE SET
  lifecycle = excluded.lifecycle, active_turn_id = excluded.active_turn_id,
  handed_over_sends = excluded.handed_over_sends, queued_sends = excluded.queued_sends,
  live_child_work = excluded.live_child_work, summary_json = excluded.summary_json,
  last_activity_at = excluded.last_activity_at, rules_version = excluded.rules_version,
  epoch = excluded.epoch, tip_seq = excluded.tip_seq, tip_ts = excluded.tip_ts`
const STATUS_COLUMNS = `st.lifecycle AS lifecycle, st.active_turn_id AS active_turn_id,
  st.handed_over_sends AS handed_over_sends, st.queued_sends AS queued_sends,
  st.live_child_work AS live_child_work, st.summary_json AS summary_json,
  st.last_activity_at AS last_activity_at`

/** Inside the transaction that wrote the rows it describes. */
export function writeJournalSessionStatus(
  db: Database.Database,
  sessionId: string,
  status: JournalSessionStatus
): void {
  const written = db
    .prepare(UPSERT_STATUS)
    .run(
      status.lifecycle,
      status.activeTurnId,
      status.handedOverSends,
      status.queuedSends,
      status.liveChildWork ? 1 : 0,
      JSON.stringify(status.summary),
      status.lastActivityAt,
      JOURNAL_SESSION_STATUS_RULES,
      sessionId
    )
  if (written.changes === 0) {
    throw new Error(`no journal history to store the status of ${sessionId} beside`)
  }
}

export function deleteJournalSessionStatus(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM journal_session_state WHERE session_id = ?').run(sessionId)
}

/** Whether the chat has a current row: by these rules, at its tip. An open writes one for a chat an
 *  older build last wrote, or wrote by other rules. */
export function hasJournalSessionStatus(db: Database.Database, sessionId: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM journal_session_state st WHERE st.session_id = ? AND st.rules_version = ?
  AND ${AT_TIP}`
      )
      .get(sessionId, JOURNAL_SESSION_STATUS_RULES) !== undefined
  )
}

/** A chat's stored status for the startup seed: null when the chat has a journal but no current
 *  row. */
export type StoredJournalSessionStatus = {
  sessionId: string
  status: JournalSessionStatus | null
}

// Bounded well under SQLite's host-parameter limit.
const IN_LIST_CHUNK = 500

/** One query per chunk of ids; ids with no journal yet are not returned. */
export function readJournalSessionStatuses(
  db: Database.Database,
  sessionIds: readonly string[]
): StoredJournalSessionStatus[] {
  const results: StoredJournalSessionStatus[] = []
  for (let start = 0; start < sessionIds.length; start += IN_LIST_CHUNK) {
    const chunk = sessionIds.slice(start, start + IN_LIST_CHUNK)
    const rows = db
      .prepare(
        `SELECT s.session_id AS session_id, ${STATUS_COLUMNS}
FROM journal_sessions s LEFT JOIN journal_session_state st
  ON st.session_id = s.session_id AND st.rules_version = ? AND ${AT_TIP}
WHERE s.session_id IN (${chunk.map(() => '?').join(', ')})`
      )
      .all(JOURNAL_SESSION_STATUS_RULES, ...chunk)
    for (const row of rows) {
      if (typeof row.session_id === 'string') {
        results.push({ sessionId: row.session_id, status: parseStatusRow(row) })
      }
    }
  }
  return results
}

/** Every chat whose current row says a gone process left it work, through the partial index. A row
 *  left behind by a chat that is gone or has moved on is never selected. */
export function readUnsettledJournalSessionIds(db: Database.Database): string[] {
  return db
    .prepare(
      `SELECT st.session_id AS session_id FROM journal_session_state st
WHERE st.rules_version = ? AND (${UNSETTLED}) AND ${AT_TIP}`
    )
    .all(JOURNAL_SESSION_STATUS_RULES)
    .flatMap((row) => (typeof row.session_id === 'string' ? [row.session_id] : []))
}

const LIFECYCLES = ['idle', 'running', 'attention'] as const

function parseStatusRow(row: Record<string, unknown>): JournalSessionStatus | null {
  const lifecycle = LIFECYCLES.find((known) => known === row.lifecycle)
  const summary = parseSummary(row.summary_json)
  if (
    !lifecycle ||
    !summary ||
    typeof row.handed_over_sends !== 'number' ||
    typeof row.queued_sends !== 'number' ||
    typeof row.last_activity_at !== 'number'
  ) {
    return null
  }
  return {
    lifecycle,
    activeTurnId: typeof row.active_turn_id === 'string' ? row.active_turn_id : null,
    handedOverSends: row.handed_over_sends,
    queuedSends: row.queued_sends,
    liveChildWork: row.live_child_work === 1,
    summary,
    lastActivityAt: row.last_activity_at
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

const SUMMARY_STATUSES = ['idle', 'working', 'attention'] as const

function parseSummaryStatus(
  value: unknown
): StructuredAgentSessionStatusProjection['status'] | undefined {
  return value === null ? null : SUMMARY_STATUSES.find((status) => status === value)
}

/** Known keys only. A value this build cannot read makes the row unreadable, so the chat is opened
 *  and publishes what its open derives rather than a row missing that field. */
function parseSummary(value: unknown): StructuredAgentSessionStatusProjection | null {
  const parsed = parseJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const source = new Map(Object.entries(parsed))
  const status = parseSummaryStatus(source.get('status'))
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

// The listing status column: written after the rows it describes commit, keyed by the cursor it
// was computed at. The epoch guard makes a write computed before an epoch change a no-op, and
// every epoch change clears the column (journal-row-table.ts), so no old position survives one.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'

const WRITE_STATUS = `UPDATE journal_sessions SET status_json = ?, status_seq = ?
WHERE session_id = ? AND epoch = ?`

export function writeJournalSessionStatus(
  db: Database.Database,
  sessionId: string,
  cursor: AgentJournalCursor,
  statusJson: string
): void {
  db.prepare(WRITE_STATUS).run(statusJson, cursor.sequence, sessionId, cursor.epoch)
}

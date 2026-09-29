// The listing status column: written after the rows it describes commit, keyed by the cursor it
// was computed at. The epoch guard makes a write computed before an epoch change a no-op, and
// every epoch change clears the column (journal-row-table.ts), so no old position survives one.

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import {
  STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
  type StructuredAgentSessionSavedStatus
} from '../../../shared/structured-agent-session-saved-status'
import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import { AgentSessionJournalError } from './journal-write-guards'

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

/**
 * One chat's status column. Written only when the epoch or the projection changes, so about once
 * per turn end, and through the chat's own queue so it lands after the rows it describes.
 * Bookkeeping: a failed write costs a later boot a miss, never a user action.
 */
export class JournalListingStatusWriter {
  /** The epoch and projection last saved or in flight. */
  private saved: string | null = null
  /** The projection object behind `saved`: the status feed re-offers its cached one on every read. */
  private offered: { epoch: string; projection: StructuredAgentSessionStatusProjection } | null =
    null

  constructor(
    private readonly deps: {
      sessionId: string
      database: () => JournalHostDatabase
      serialize: <T>(run: () => Promise<T>) => Promise<T>
    }
  ) {}

  save(
    cursor: AgentJournalCursor,
    projection: StructuredAgentSessionStatusProjection,
    lastActivityAt: number
  ): void {
    if (this.offered?.projection === projection && this.offered.epoch === cursor.epoch) {
      return
    }
    const key = `${cursor.epoch}\n${JSON.stringify(projection)}`
    const offered = { epoch: cursor.epoch, projection }
    if (key === this.saved) {
      this.offered = offered
      return
    }
    const status: StructuredAgentSessionSavedStatus = {
      v: STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
      projection,
      lastActivityAt
    }
    this.saved = key
    this.offered = offered
    this.deps
      .serialize(async () =>
        writeJournalSessionStatus(
          this.deps.database().db,
          this.deps.sessionId,
          cursor,
          JSON.stringify(status)
        )
      )
      .catch((error: unknown) => {
        if (this.saved === key) {
          this.saved = null
          this.offered = null
        }
        if (!(error instanceof AgentSessionJournalError && error.code === 'journal_closed')) {
          console.warn('[agent-session-journal] saving the listing status failed', error)
        }
      })
  }
}

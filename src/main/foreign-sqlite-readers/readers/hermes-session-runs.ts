import { escapeSqlLike } from '../../automations/hermes-cron-output-markdown'
import SyncDatabase from '../../sqlite/sync-database'
import type { HermesSessionRow, HermesSessionRunRows } from '../hermes-session-runs-result'

function openStateDb(dbPath: string): SyncDatabase {
  return new SyncDatabase(dbPath, { readonly: true, fileMustExist: true })
}

/**
 * Every cron session row of one Hermes job, newest first. A failed open throws.
 * @param dbPath - Hermes's state.db.
 * @param jobId - Hermes cron job id; its sessions are named `cron_<jobId>_<run>`.
 */
export function readHermesSessionRunRefRows(dbPath: string, jobId: string): HermesSessionRow[] {
  const db = openStateDb(dbPath)
  try {
    const pattern = `cron\\_${escapeSqlLike(jobId)}\\_%`
    return db
      .prepare(
        `SELECT id, started_at
           FROM sessions
          WHERE id LIKE ? ESCAPE '\\'
          ORDER BY started_at DESC`
      )
      .all(pattern)
  } finally {
    db.close()
  }
}

/**
 * The session row and messages of each run, from one open of state.db. A run
 * that is missing or fails to read is left out; a failed open throws.
 * @param dbPath - Hermes's state.db.
 * @param runIds - Session ids to read.
 */
export function readHermesSessionRuns(
  dbPath: string,
  runIds: readonly string[]
): HermesSessionRunRows[] {
  const db = openStateDb(dbPath)
  try {
    const runs: HermesSessionRunRows[] = []
    for (const id of runIds) {
      try {
        const session = db
          .prepare(
            `SELECT id, title, started_at, ended_at, end_reason, model, message_count,
                    input_tokens, output_tokens, estimated_cost_usd
               FROM sessions
              WHERE id = ?`
          )
          .get(id)
        if (!session) {
          continue
        }
        const messages = db
          .prepare(
            `SELECT role, content, tool_name, reasoning, reasoning_content
                 FROM messages
                WHERE session_id = ?
                ORDER BY timestamp, id`
          )
          .all(id)
        runs.push({ id, session, messages })
      } catch {
        // One unreadable run reads as missing, as it did when each run opened state.db alone.
      }
    }
    return runs
  } finally {
    db.close()
  }
}

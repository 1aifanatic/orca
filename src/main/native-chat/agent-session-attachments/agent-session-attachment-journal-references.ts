import type Database from '../../sqlite/sync-database'

/**
 * Whether a chat's journal or its host-held queued drafts mention `needle` (a JSON-escaped path).
 * Null when the chat has no journal rows at all: an unread or not-yet-written journal is no
 * evidence that a file was never sent.
 */
export function createAgentSessionAttachmentJournalMentions(
  db: () => Database.Database
): (sessionId: string, needle: string) => boolean | null {
  return (sessionId, needle) => {
    const connection = db()
    const hasRows = connection
      .prepare('SELECT 1 FROM journal_rows WHERE session_id = ? LIMIT 1')
      .get(sessionId)
    if (!hasRows) {
      return null
    }
    const inRows = connection
      .prepare('SELECT 1 FROM journal_rows WHERE session_id = ? AND instr(row_json, ?) > 0 LIMIT 1')
      .get(sessionId, needle)
    if (inRows) {
      return true
    }
    const inQueue = connection
      .prepare(
        'SELECT 1 FROM queued_messages WHERE session_id = ? AND instr(body_json, ?) > 0 LIMIT 1'
      )
      .get(sessionId, needle)
    return Boolean(inQueue)
  }
}

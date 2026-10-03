// A card whose sender restates it as it is sent (an agent's mail notice counting the mail owed
// now): the row is rewritten in the hand-off's own transaction, so it records what was sent.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  serializeAgentSessionMessageSource,
  type AgentSessionMessageSource
} from '../../../shared/agent-session-message-source'

export type QueuedMessageRestatement = {
  body: AgentJournalMessageItem
  fingerprint: string
  source: AgentSessionMessageSource
}

/** MUST run inside the consume's transaction, before it; false when the card is not `expect`. */
export function restateQueuedMessageInTransaction(
  db: Database.Database,
  input: {
    sessionId: string
    messageId: string
    expect: 'waiting' | 'returned'
    restated: QueuedMessageRestatement
  }
): boolean {
  const changed = db
    .prepare(
      `UPDATE queued_messages SET body_json = ?, fingerprint = ?, source_json = ?
       WHERE session_id = ? AND message_id = ? AND state = ?`
    )
    .run(
      JSON.stringify(input.restated.body),
      input.restated.fingerprint,
      serializeAgentSessionMessageSource(input.restated.source),
      input.sessionId,
      input.messageId,
      input.expect
    )
  return Number(changed.changes ?? 0) === 1
}

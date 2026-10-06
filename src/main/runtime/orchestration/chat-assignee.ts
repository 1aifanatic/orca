/**
 * A chat as a Dispatch assignee. Its Dispatch row names it by its `/clear` root address,
 * `orca_session_id:<root>`, and holds no pane or process: whether it can still work is read off the
 * session records the same way mail to it is, so the two can never disagree.
 */

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  ORCA_SESSION_ADDRESS_PREFIX,
  parseOrcaSessionAddress,
  type OrcaSessionId
} from '../../../shared/orca-session-address'
import type { OrchestrationDb } from './db'
import { DISPATCH_CONTEXT_COLUMN_LIST } from './db/row-column-lists'
import type { DispatchContextRow } from './types'
import { structuredSessionMailReach } from './structured-session-mail-address'
import {
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/** The chat a Dispatch assignee handle names; null for a terminal or a structured worker. */
export function chatAssigneeSessionId(
  assigneeHandle: string | null | undefined
): OrcaSessionId | null {
  return assigneeHandle ? parseOrcaSessionAddress(assigneeHandle) : null
}

export type ChatAssigneeObservation =
  /** `session` is the conversation's live session: its `/clear` successor, if it has one. */
  | { status: 'live'; session: AgentSessionRecord }
  | { status: 'exited'; reason: string }
  | { status: 'unverifiable'; reason: string }

/**
 * A chat at rest is live: the send that reaches it starts its agent. Only a closed or lost
 * conversation has exited; not being able to look, or another host, is unverifiable.
 */
export function observeChatAssignee(
  sessionId: OrcaSessionId,
  db: OrchestrationDb | null | undefined,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): ChatAssigneeObservation {
  if (!store) {
    return {
      status: 'unverifiable',
      reason: 'The agent-session host is not installed in this runtime generation.'
    }
  }
  const record = store.getRecord(sessionId)
  if (!record) {
    return { status: 'unverifiable', reason: 'No durable record backs this chat.' }
  }
  const reach = structuredSessionMailReach(store, record, db)
  switch (reach.kind) {
    case 'reachable':
      return { status: 'live', session: reach.session }
    case 'other-host':
      return { status: 'unverifiable', reason: 'The chat runs on another host.' }
    case 'ended':
      return {
        status: 'exited',
        reason:
          reach.reason === 'closed'
            ? 'The chat was closed.'
            : 'The chat was cleared, and this host has no record of the session that continues it.'
      }
  }
}

/**
 * Every unsettled Dispatch whose chat has exited, re-derived from the records on each call: a
 * closed chat's Dispatch settles as a closed terminal's does, and nothing is remembered to miss.
 */
export function exitedChatAssigneeDispatches(
  db: OrchestrationDb,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): DispatchContextRow[] {
  if (!store) {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts
        WHERE status IN ('pending', 'dispatched') AND substr(assignee_handle, 1, ?) = ?`
    )
    .all(ORCA_SESSION_ADDRESS_PREFIX.length, ORCA_SESSION_ADDRESS_PREFIX)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The schema-pinned complete Dispatch projection returns Dispatch rows; the adapter exposes unknown.
  return (rows as DispatchContextRow[]).filter((dispatch) => {
    const sessionId = chatAssigneeSessionId(dispatch.assignee_handle)
    return sessionId !== null && observeChatAssignee(sessionId, db, store).status === 'exited'
  })
}

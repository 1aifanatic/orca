import type Database from '../sqlite/sync-database'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import {
  agentSessionClosedOwnerKey,
  closedAgentSessionOwner,
  isReadableAgentSessionClosedOwner,
  type AgentSessionClosedOwner
} from './agent-session-closed-owner'

function parsed(value: unknown): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : null
  } catch {
    return null
  }
}

export function loadAgentSessionClosedOwnerRows(
  db: Database.Database
): Map<string, AgentSessionClosedOwner> {
  const facts = new Map<string, AgentSessionClosedOwner>()
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('agent_session_closed_owners')
  ) {
    return facts
  }
  for (const row of db
    .prepare(
      'SELECT owner_key, session_id, fact_json FROM agent_session_closed_owners ORDER BY rowid'
    )
    .all()) {
    const fact = parsed(row.fact_json)
    if (
      typeof row.owner_key === 'string' &&
      isReadableAgentSessionClosedOwner(row.owner_key, fact) &&
      row.session_id === fact.sessionId
    ) {
      facts.set(row.owner_key, fact)
    }
  }
  return facts
}

export function writeAgentSessionClosedOwnerRows(
  db: Database.Database,
  writes: { upsert: [string, string][]; remove: string[] }
): void {
  for (const [key, json] of writes.upsert) {
    const fact = parsed(json)
    if (!isReadableAgentSessionClosedOwner(key, fact)) {
      throw new Error('agent_session_store_write_invalid')
    }
    db.prepare(
      'INSERT INTO agent_session_closed_owners (owner_key, session_id, fact_json) VALUES (?, ?, ?)'
    ).run(key, fact.sessionId, json)
  }
  for (const key of writes.remove) {
    db.prepare('DELETE FROM agent_session_closed_owners WHERE owner_key = ?').run(key)
  }
}

/** One-time schema migration: an older proof cannot recover a cleared process or past cutoff. */
export function migrateAgentSessionClosedOwnerRows(db: Database.Database): void {
  for (const row of db.prepare('SELECT session_id, record_json FROM agent_session_records').all()) {
    const stored = parsed(row.record_json)
    if (!isPersistedAgentSessionRecord(stored) || stored.sessionId !== row.session_id) {
      continue
    }
    const { record } = decodePersistedAgentSessionRecord(stored)
    const evidence = record.lease.deathEvidence
    const fact =
      evidence?.ownerFence !== undefined && evidence.ownerFence <= record.lease.runtimeFence
        ? closedAgentSessionOwner(record, evidence)
        : null
    if (fact) {
      writeAgentSessionClosedOwnerRows(db, {
        upsert: [[agentSessionClosedOwnerKey(fact), JSON.stringify(fact)]],
        remove: []
      })
    }
  }
}

import type Database from '../sqlite/sync-database'
import type {
  AgentSessionDeathEvidence,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import { readJournalSessionEpoch } from '../native-chat/agent-session-journal/journal-row-table'
import { agentSessionClosedOwnerKey, closedAgentSessionOwner } from './agent-session-closed-owner'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { agentSessionRuntimeIncarnation } from './agent-session-runtime-attribution'
import {
  adjudicateAgentSessionRestart,
  type AgentSessionOwnerProbe
} from '../../shared/agent-session-lease-adjudication'

export function retainAgentSessionReservationClosure(
  state: AgentSessionStoreState,
  record: AgentSessionRecord,
  probe: AgentSessionOwnerProbe,
  observedAt: number
): void {
  const proof = adjudicateAgentSessionRestart({ lease: record.lease, probe, observedAt })
  if (proof.disposition === 'evicted' && proof.evidence) {
    retainAgentSessionClosedOwner(state, record, proof.evidence)
  }
}

export function retainAgentSessionClosedOwner(
  state: AgentSessionStoreState,
  record: AgentSessionRecord,
  evidence: AgentSessionDeathEvidence
): void {
  if (evidence.ownerFence !== record.lease.runtimeFence) {
    return
  }
  const fact = closedAgentSessionOwner(record, evidence)
  if (fact) {
    const key = agentSessionClosedOwnerKey(fact)
    if (!state.closedOwners.has(key)) {
      state.closedOwners.set(key, fact)
    }
  }
}

/** Captures every proof writer after runtime attribution, before the draft's rows are written. */
export function captureAgentSessionClosedOwners(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState,
  db: Database.Database
): void {
  for (const [sessionId, record] of draft.records) {
    const before = published.records.get(sessionId)
    const evidence = record.lease.deathEvidence
    if (before && evidence && evidence !== before.lease.deathEvidence) {
      retainAgentSessionClosedOwner(draft, before, evidence)
    }
  }
  for (const [key, fact] of draft.closedOwners) {
    if (!draft.records.has(fact.sessionId) && !draft.unreadableRecords.has(fact.sessionId)) {
      draft.closedOwners.delete(key)
      continue
    }
    if (published.closedOwners.has(key)) {
      continue
    }
    const before = published.records.get(fact.sessionId)
    const runtime = before?.lease.ownerProcess?.runtime
    const runtimeEnd =
      runtime && runtime !== agentSessionRuntimeIncarnation()
        ? draft.runtimeEnds?.get(runtime)
        : undefined
    const epoch = readJournalSessionEpoch(db, fact.sessionId)
    const sequence = epoch
      ? (db
          .prepare(
            'SELECT MAX(seq) AS sequence FROM journal_rows WHERE session_id = ? AND epoch = ?'
          )
          .get(fact.sessionId, epoch)?.sequence ?? 0)
      : undefined
    draft.closedOwners.set(key, {
      ...fact,
      evidence:
        fact.evidence.runtimeEnd === undefined &&
        runtimeEnd &&
        before?.lease.claimStatus !== 'conflicted'
          ? { ...fact.evidence, runtimeEnd }
          : fact.evidence,
      journalBoundary: epoch && typeof sequence === 'number' ? { epoch, sequence } : null
    })
  }
}

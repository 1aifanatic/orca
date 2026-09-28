// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires proof the child is gone, which is exactly when a lease carries death
// evidence: a watched exit, or a local probe that found the recorded pid gone or reused. A release
// nothing proved — lost contact, an unverifiable identity, a stop that outlived the ladder — carries
// none, and its turn is `unverifiable` with no end at all.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import { nextAgentSessionFence } from '../../../shared/agent-session-next-fence'
import type { AgentSessionLease } from '../../../shared/agent-session-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionTurnVerdict =
  | { state: 'interrupted'; completedAt: number }
  | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

/** The lease as read with its death evidence: the fence its release moved to names the owner. */
export type StructuredAgentSessionDeathRecord = Pick<
  AgentSessionLease,
  'deathEvidence' | 'runtimeFence' | 'minimumNextFence'
>

export function turnVerdictFromDeathEvidence(
  lease: StructuredAgentSessionDeathRecord | null | undefined,
  journal: Pick<AgentSessionJournal, 'lastLiveActivityAt' | 'lastLiveFence'>
): StructuredAgentSessionTurnVerdict {
  const evidence = lease?.deathEvidence
  if (!lease || !evidence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.kind === 'exit-observed') {
    return { state: 'interrupted', completedAt: evidence.observedAt }
  }
  // A probe finds a dead child long after it died. The later of the last renewal and the last row
  // it wrote bounds its end, so the turn never counts the time Orca itself was down. The renewal
  // counts only when the release that recorded it moved past the generation that wrote the turn.
  const sameOwner =
    lease.runtimeFence ===
    nextAgentSessionFence({ ...lease, runtimeFence: journal.lastLiveFence() })
  const lastProvenAliveAt = sameOwner ? (evidence.lastProvenAliveAt ?? 0) : 0
  const lastSeen = Math.max(lastProvenAliveAt, journal.lastLiveActivityAt())
  return {
    state: 'interrupted',
    completedAt: lastSeen > 0 ? Math.min(lastSeen, evidence.observedAt) : evidence.observedAt
  }
}

/** Revises every still-running lifecycle item in place, keeping its identity and start. */
export function runningTurnLifecycleRevisions(
  items: readonly AgentJournalRenderItem[],
  verdict: StructuredAgentSessionTurnVerdict
): JournalLifecycleMutationInput[] {
  const revisions: JournalLifecycleMutationInput[] = []
  for (const item of items) {
    const turn = readAgentJournalTurn(item.body)
    if (turn?.state !== 'running') {
      continue
    }
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!identity) {
      continue
    }
    revisions.push({
      kind: 'item',
      identity,
      body: agentJournalTurnBody(settledLifecycle(turn, verdict))
    })
  }
  return revisions
}

/** The verdict owns the turn's end and nothing else; every other field the row
 *  carries, including ones this build does not know, stays as it was. */
function settledLifecycle(
  lifecycle: AgentJournalTurnLifecycle,
  verdict: StructuredAgentSessionTurnVerdict
): AgentJournalTurnLifecycle {
  const {
    state: _state,
    outcome: _outcome,
    completedAt: _completedAt,
    durationMs: _durationMs,
    ...kept
  } = lifecycle
  return verdict.state === 'interrupted'
    ? { ...kept, state: verdict.state, completedAt: verdict.completedAt }
    : { ...kept, state: verdict.state }
}

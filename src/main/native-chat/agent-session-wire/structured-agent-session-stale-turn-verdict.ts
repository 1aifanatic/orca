// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires proof that the child which wrote the turn is gone: death evidence naming
// that turn's owner by fence — a watched exit, or a local probe that found the recorded pid gone or
// reused. A release nothing proved — lost contact, an unverifiable identity, a stop that outlived the
// ladder — carries none, and neither does a later owner's death; the turn is then `unverifiable`
// with no end at all.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export type StructuredAgentSessionTurnVerdict =
  | { state: 'interrupted'; completedAt: number }
  | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined,
  journal: Pick<AgentSessionJournal, 'lastLiveActivityAt'>,
  /** Fence of the owner that wrote the turn. */
  turnFence: number | undefined
): StructuredAgentSessionTurnVerdict {
  if (!evidence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence === undefined) {
    // Evidence an older build wrote names no owner; it keeps the rule that build applied.
    return evidence.kind === 'exit-observed'
      ? { state: 'interrupted', completedAt: evidence.observedAt }
      : UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.ownerFence !== turnFence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  if (evidence.kind === 'exit-observed') {
    return { state: 'interrupted', completedAt: evidence.observedAt }
  }
  // A probe finds a dead child long after it died. The later of the last renewal and the last row
  // it wrote bounds its end, so the turn never counts the time Orca itself was down.
  const lastSeen = Math.max(evidence.lastProvenAliveAt ?? 0, journal.lastLiveActivityAt())
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

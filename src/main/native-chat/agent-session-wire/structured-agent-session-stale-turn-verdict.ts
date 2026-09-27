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
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'

export type StructuredAgentSessionTurnVerdict =
  | { state: 'interrupted'; completedAt: number }
  | { state: 'unverifiable' }

export const UNVERIFIABLE_TURN_VERDICT: StructuredAgentSessionTurnVerdict = {
  state: 'unverifiable'
}

export function turnVerdictFromDeathEvidence(
  evidence: AgentSessionDeathEvidence | null | undefined,
  lastLiveActivityAt: number
): StructuredAgentSessionTurnVerdict {
  if (!evidence) {
    return UNVERIFIABLE_TURN_VERDICT
  }
  // A probe finds a dead child long after it died; the last row it wrote bounds its end, so the
  // turn never counts the time Orca itself was down.
  return {
    state: 'interrupted',
    completedAt:
      evidence.kind === 'exit-observed' || lastLiveActivityAt <= 0
        ? evidence.observedAt
        : Math.min(lastLiveActivityAt, evidence.observedAt)
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

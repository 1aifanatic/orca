// What the host may durably say about a turn whose provider child is gone.
//
// `interrupted` requires the host to have seen the child exit; that receipt is the only end time it
// is allowed to record. Everything weaker — a pid probe, an identity mismatch, a journal found
// running with no observed exit on the record — is `unverifiable` and carries no end at all.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import {
  agentJournalTurnBody,
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
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
  evidence: AgentSessionDeathEvidence | null | undefined
): StructuredAgentSessionTurnVerdict {
  return evidence?.kind === 'exit-observed'
    ? { state: 'interrupted', completedAt: evidence.observedAt }
    : UNVERIFIABLE_TURN_VERDICT
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

/** The turns already over before a stop reaches the provider: the only ones it cannot have cut. */
export function endedTurnItemIds(items: readonly AgentJournalRenderItem[]): ReadonlySet<string> {
  return new Set(
    items
      .filter((item) => {
        const state = readAgentJournalTurn(item.body)?.state
        return state !== undefined && state !== 'running'
      })
      .map((item) => item.itemId)
  )
}

/**
 * A stop the user aimed at this chat is their cancellation, on every turn it cut short: one still
 * running, or one the provider settled on its way out with no verdict of its own. That includes a
 * turn whose start landed only as the provider stopped. A verdict the provider did give stands.
 */
export function userStoppedTurnRevisions(
  items: readonly AgentJournalRenderItem[],
  endedBeforeStop: ReadonlySet<string>,
  completedAt: number
): JournalLifecycleMutationInput[] {
  const revisions: JournalLifecycleMutationInput[] = []
  for (const item of items) {
    if (endedBeforeStop.has(item.itemId)) {
      continue
    }
    const turn = readAgentJournalTurn(item.body)
    const identity = parseAgentJournalItemKey(item.itemId)
    if (!turn || !identity || readAgentJournalTurnOutcome(turn)) {
      continue
    }
    const ended =
      turn.state === 'running'
        ? settledLifecycle(turn, { state: 'interrupted', completedAt })
        : turn.state === 'interrupted'
          ? turn
          : null
    if (ended) {
      revisions.push({
        kind: 'item',
        identity,
        body: agentJournalTurnBody({ ...ended, outcome: 'cancellation' })
      })
    }
  }
  return revisions
}

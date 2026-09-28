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
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedEvent
} from './structured-agent-session-adapter'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'

export type StructuredAgentSessionTurnVerdict =
  /** `cancellation` only for a stop the user aimed at this chat: every other cut is news. */
  | { state: 'interrupted'; completedAt: number; outcome?: 'cancellation' }
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

/**
 * The one mapping from why a provider child ended to what the turn it cut reads as. Each adapter
 * settles its own open turn through it on `ended`, and the host's fallback settles through it any
 * turn no adapter did. Only a stop the user aimed at this chat is their cancellation.
 */
export function turnVerdictForChildEnd(
  cause: StructuredAgentSessionChildEndCause,
  completedAt: number
): Extract<StructuredAgentSessionTurnVerdict, { state: 'interrupted' }> {
  switch (cause) {
    case 'user-stop':
    case 'user-close':
      return { state: 'interrupted', completedAt, outcome: 'cancellation' }
    case 'host-stop':
    case 'evict':
    case 'exit':
    case 'attach-failed':
      return { state: 'interrupted', completedAt }
  }
}

/** Why the child an `ended` event reports ended: who asked for a close, else an exit it had. A
 *  requested close with no cause named is the host's own. */
export function childEndCauseOfEndedEvent(
  event: { type: 'ended' } & Partial<Pick<StructuredAgentSessionEndedEvent, 'cause' | 'stopCause'>>
): StructuredAgentSessionChildEndCause {
  if (event.cause === 'unexpected-exit') {
    return 'exit'
  }
  return event.stopCause ?? 'host-stop'
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
    ? {
        ...kept,
        state: verdict.state,
        completedAt: verdict.completedAt,
        ...(verdict.outcome ? { outcome: verdict.outcome } : {})
      }
    : { ...kept, state: verdict.state }
}

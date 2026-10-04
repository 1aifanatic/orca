// The shape of a decision on one non-text event, and the reads every rule shares.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { StructuredAgentSessionItemAppendOptions } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineHold } from './provider-timeline-budget'
import type { ProviderTimelineContext } from './provider-timeline-context'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import type { ProviderTimelineKey } from './provider-timeline-identity'
import type { ProviderTimelineTurnRef } from './provider-timeline-joins'
import {
  providerTimelineSettlement,
  type ProviderTimelineTurnEnd
} from './provider-timeline-settlement'
import type { ProviderTimelineState } from './provider-timeline-state'

/** Why an event wrote nothing. Each is a grammar rule the adapter broke or a replay it repeated. */
export type ProviderTimelineDropRule =
  | 'session-ended'
  | 'turn-duplicate'
  | 'turn-replayed'
  | 'turn-unknown'
  | 'no-turn'
  | 'item-settled'
  | 'item-replayed'
  | 'request-duplicate'
  | 'request-replayed'
  | 'request-unknown'
  | 'stream-unknown'
  | 'stream-mismatch'

/** A non-text event with the keys planning minted for it, so execution names the same ones. */

/** A non-text event with the keys planning minted for it, so execution names the same ones. */
export type ProviderTimelineDecidedEvent = Exclude<
  ProviderTimelineEvent,
  { type: 'text.delta' | 'text.close' | 'activity' }
> & { minted?: ProviderTimelineKey }

export type ProviderTimelineResolvedWrite = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options?: StructuredAgentSessionItemAppendOptions
}

export type ProviderTimelineDecision = {
  dropped?: ProviderTimelineDropRule
  /** What the event would hold open, for the budget. */
  hold?: ProviderTimelineHold
  /** The event's change to what is known: the forecast's at admission, the ledger's at execution. */
  commit?: (state: ProviderTimelineState) => void
  /** Execution only: the settlement step's mutations and the item step's write. */
  settle?: readonly JournalLifecycleMutationInput[]
  write?: ProviderTimelineResolvedWrite | null
  /** The item the event closes, whose stream it releases. */
  closes?: string
}

export type ProviderTimelineDecisionInput = {
  context: ProviderTimelineContext
  state: ProviderTimelineState
  journal: StructuredAgentSessionTransitionJournal | null
  /** Execution: place rows and compute writes. Planning never does. */
  execute: boolean
}

export const providerKey = (value: string): ProviderTimelineKey => ({ source: 'provider', value })

export function settledTool(body: AgentJournalItemBody | null): boolean {
  return body?.kind === 'tool-call' && body.state !== 'running'
}

export function runningTool(body: AgentJournalItemBody): boolean {
  return body.kind === 'tool-call' && body.state === 'running'
}

export function pendingPrompt(body: AgentJournalItemBody | null): boolean {
  return (
    (body?.kind === 'approval' || body?.kind === 'question') && body.resolution.state === 'pending'
  )
}

export function turnOf(scope: { kind: string; turnItemId?: string }): string | null {
  return scope.kind === 'turn' ? (scope.turnItemId ?? null) : null
}

/** A turn's journal-derived settlement, at execution. */
export function settlementOf(
  input: ProviderTimelineDecisionInput,
  turn: ProviderTimelineTurnRef,
  end: ProviderTimelineTurnEnd
): readonly JournalLifecycleMutationInput[] | undefined {
  if (!input.execute || !input.journal) {
    return undefined
  }
  return providerTimelineSettlement(input.journal, { turnItemId: turn.itemId }, [turn], end)
}

/** A replayed event for a turn the provider itself completed: the journal holds that turn whole.
 *  Completion is final, so planning's possibly older journal never drops what execution would keep. */
export function replaysCompletedTurn(
  input: ProviderTimelineDecisionInput,
  join: { turn?: string } | undefined
): boolean {
  if (join?.turn === undefined || !input.journal) {
    return false
  }
  const turn = input.context.joins.turn(providerKey(join.turn), input.state.namespace)
  return (
    readAgentJournalTurn(input.journal.itemBody(turn.itemId) ?? undefined)?.state === 'completed'
  )
}

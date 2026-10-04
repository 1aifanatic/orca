// What turn, send, context and session events do, decided on the forecast and again on the ledger.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'
import {
  providerKey,
  settlementOf,
  type ProviderTimelineDecidedEvent,
  type ProviderTimelineDecision,
  type ProviderTimelineDecisionInput,
  type ProviderTimelineResolvedWrite
} from './provider-timeline-decision'
import { providerTimelinePlacement } from './provider-timeline-context'
import type { ProviderTimelineTurnRef } from './provider-timeline-joins'
import {
  providerTimelineSettlement,
  runningProviderTimelineTurns,
  type ProviderTimelineTurnEnd
} from './provider-timeline-settlement'
import type { ProviderTimelineState } from './provider-timeline-state'

export function decideTurnOpen(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.open' }>
): ProviderTimelineDecision {
  const { state, context } = input
  const open = state.open
  const key = event.turn === undefined ? event.minted : providerKey(event.turn)
  if (!key || (event.turn === undefined && open)) {
    return { dropped: 'turn-duplicate' }
  }
  const turn = context.joins.turn(key, state.namespace)
  if (open?.itemId === turn.itemId) {
    return { dropped: 'turn-duplicate' }
  }
  if (state.status(turn, input.journal) !== 'absent') {
    return { dropped: 'turn-replayed' }
  }
  const pending = state.opener(turn.itemId)
  const running: AgentJournalTurnLifecycle = {
    turnId: turn.turnId,
    state: 'running',
    userItemId: pending
      ? agentJournalSubmissionKey(pending.clientMessageId)
      : context.joins.turnOpener(turn),
    startedAt: event.at,
    ...(pending ? { requestedAt: pending.requestedAt } : {})
  }
  // A newer turn ended this one, whoever asked for it.
  const superseded = open
    ? settlementOf(input, open, {
        state: 'interrupted',
        completedAt: event.at,
        outcome: 'superseded'
      })
    : []
  return {
    ...(superseded ? { settle: superseded } : {}),
    write: input.execute
      ? {
          identity: turn.identity,
          body: agentJournalTurnBody(running),
          // The running row's ts is the turn start itself, so clients read no append lag.
          options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true, observedAt: event.at }
        }
      : null,
    commit: (next) => {
      if (next.open) {
        next.endTurn(next.open)
      }
      if (pending) {
        next.inputs = next.inputs.filter(
          (input) => input.clientMessageId !== pending.clientMessageId
        )
      }
      next.open = { ...turn, running }
    }
  }
}

export function decideTurnEnd(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.end' }>
): ProviderTimelineDecision {
  const { state } = input
  const turn =
    event.turn === undefined
      ? state.open
      : input.context.joins.turn(providerKey(event.turn), state.namespace)
  if (!turn) {
    return { dropped: 'no-turn' }
  }
  if (state.status(turn, input.journal) !== 'running') {
    return { dropped: 'turn-unknown' }
  }
  const settle = settlementOf(input, turn, {
    state: event.state,
    completedAt: event.at,
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
  })
  return { ...(settle ? { settle } : {}), commit: (next) => next.endTurn(turn) }
}

export function decideInput(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'input.accepted' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const named = event.join?.turn
  const placement = providerTimelinePlacement(context, state, event.join)
  if (input.execute && journal && placement.turn && event.join?.item !== undefined) {
    context.joins.reserveEcho(
      { family: 'item', key: providerKey(event.join.item), thread: event.join.thread ?? null },
      placement,
      journal
    )
  }
  const open = state.open
  const namedTurn =
    named === undefined ? null : context.joins.turn(providerKey(named), state.namespace)
  const status = namedTurn ? state.status(namedTurn, journal) : null
  // A late echo of a turn already over names nothing.
  if (status === 'settled' || (status === 'running' && namedTurn?.itemId !== open?.itemId)) {
    return {}
  }
  const pending = {
    clientMessageId: event.clientMessageId,
    requestedAt: event.requestedAt,
    ...(namedTurn && status === 'absent' ? { turnItemId: namedTurn.itemId } : {})
  }
  // No turn open, or the send names one still to open: it waits for that turn.
  if (!open || pending.turnItemId !== undefined) {
    return {
      commit: (next) => next.wait(pending)
    }
  }
  // Only a turn still naming its fallback opener takes the send; the journal's row says, once there.
  const opener =
    readAgentJournalTurn(journal?.itemBody(open.itemId) ?? undefined)?.userItemId ??
    open.running.userItemId
  if (opener !== context.joins.turnOpener(open)) {
    return {}
  }
  const userItemId = agentJournalSubmissionKey(event.clientMessageId)
  const running = { ...open.running, userItemId, requestedAt: event.requestedAt }
  return {
    write:
      input.execute && journal ? reviseOpener(journal, open, userItemId, event.requestedAt) : null,
    commit: (next) => {
      if (next.open?.itemId === open.itemId) {
        next.open = { ...next.open, running }
      }
    }
  }
}

/** Only the opener fields change; the rest are the row's as the journal holds it. */
export function reviseOpener(
  journal: StructuredAgentSessionTransitionJournal,
  open: ProviderTimelineTurnRef,
  userItemId: string,
  requestedAt: number
): ProviderTimelineResolvedWrite | null {
  const row = readAgentJournalTurn(journal.itemBody(open.itemId) ?? undefined)
  if (row?.state !== 'running') {
    return null
  }
  const target = { identity: open.identity }
  const write = {
    lifecycle: agentJournalTurnBody({ ...row, userItemId, requestedAt }),
    onlyWhileRunning: true as const
  }
  const resolved = resolveAgentJournalTurnRowWrite(
    journal,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
  return (
    resolved && { ...resolved, options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true } }
  )
}

export function decideSessionEnd(
  input: ProviderTimelineDecisionInput,
  end: ProviderTimelineTurnEnd,
  commit: (state: ProviderTimelineState) => void
): ProviderTimelineDecision {
  const { journal } = input
  return {
    ...(input.execute && journal
      ? {
          settle: providerTimelineSettlement(
            journal,
            'session',
            runningProviderTimelineTurns(journal),
            end
          )
        }
      : {}),
    commit
  }
}

export function decideContextUsage(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'context.usage' }>
): ProviderTimelineDecision {
  const { state, journal } = input
  const named = event.join?.turn
  const turn =
    named === undefined
      ? (state.open ?? state.latest)
      : input.context.joins.turn(providerKey(named), state.namespace)
  if (!input.execute || !journal) {
    return {}
  }
  const target = turn ? { identity: turn.identity } : ({ newest: true } as const)
  const write = { contextUsage: event.usage }
  const resolved = resolveAgentJournalTurnRowWrite(
    journal,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
  return {
    write: resolved && { ...resolved, options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE } }
  }
}

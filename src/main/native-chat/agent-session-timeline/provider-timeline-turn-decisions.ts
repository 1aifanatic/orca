// What turn, user-message, context and session events do: admitted on the state, written
// against the journal.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  agentJournalTurnRowReservedBytes,
  resolveAgentJournalTurnRowWrite
} from './agent-journal-turn-row-revision'
import { providerTimelinePlacement } from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision,
  ProviderTimelineDecisionInput,
  ProviderTimelineItemWrite,
  ProviderTimelineResolvedWrite
} from './provider-timeline-decision'
import {
  providerKey,
  providerTimelineTurnRowState,
  type ProviderTimelineTurnRef
} from './provider-timeline-rows'
import {
  providerTimelineSettlement,
  runningProviderTimelineTurns,
  type ProviderTimelineSettlementEnding
} from './provider-timeline-settlement'
import type {
  ProviderTimelineOpenTurn,
  ProviderTimelinePendingInput
} from './provider-timeline-state'

/** Room for a settled turn row and its context facts. */
const TURN_ROW_RESERVED_BYTES = 64 * 1024

export function decideTurnOpen(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.open' }>
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const open = state.open
  // An open naming no turn while one is open is the same turn, not a new one.
  if (event.turn === undefined && open) {
    return { dropped: 'turn-duplicate' }
  }
  const turn = context.rows.turn(
    event.turn === undefined ? context.rows.minted('t', input.serial()) : providerKey(event.turn)
  )
  const held = journal ? providerTimelineTurnRowState(journal, turn.itemId) : 'absent'
  if (open?.itemId === turn.itemId || held === 'running') {
    return { dropped: 'turn-duplicate' }
  }
  if (held === 'settled') {
    return { dropped: 'turn-settled' }
  }
  const pending = state.opener(turn.itemId)
  const running: AgentJournalTurnLifecycle = {
    turnId: turn.turnId,
    state: 'running',
    userItemId: pending?.userItemId ?? turn.itemId,
    startedAt: event.at,
    ...(pending?.requestedAt === undefined ? {} : { requestedAt: pending.requestedAt })
  }
  const write: ProviderTimelineResolvedWrite = {
    identity: turn.identity,
    body: agentJournalTurnBody(running)
  }
  return {
    // A newer turn ended this one, whoever asked for it.
    ...(open
      ? {
          settle: {
            what: 'turn-superseded',
            resolve: (journal) =>
              providerTimelineSettlement(
                journal,
                { turnItemId: open.itemId },
                {
                  turns: [open],
                  end: { state: 'interrupted', completedAt: event.at, outcome: 'superseded' }
                }
              )
          }
        }
      : {}),
    writes: [
      {
        reservedBytes: TURN_ROW_RESERVED_BYTES,
        lifecycle: true,
        // The running row's ts is the turn start itself, so clients read no append lag.
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true, observedAt: event.at },
        // Only where no row is: a turn the journal already holds is never written back to running.
        resolve: (at) => (at.itemBody(turn.itemId) === null ? write : null)
      }
    ],
    commit: (next) => {
      if (next.open) {
        next.endTurn(next.open)
      }
      if (pending) {
        next.inputs = next.inputs.filter((each) => each !== pending)
      }
      next.open = { ...turn, running }
    }
  }
}

export function decideTurnEnd(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.end' }>
): ProviderTimelineDecision {
  const { state, journal } = input
  const turn =
    event.turn === undefined ? state.open : input.context.rows.turn(providerKey(event.turn))
  if (!turn) {
    return { dropped: 'no-turn' }
  }
  // A turn this run opened, or one the journal holds (open, superseded, or ended by another
  // writer): its end settles whatever is left, and a settled row is not written again.
  const known =
    state.open?.itemId === turn.itemId ||
    state.latest?.itemId === turn.itemId ||
    !journal ||
    providerTimelineTurnRowState(journal, turn.itemId) !== 'absent'
  if (!known) {
    return { dropped: 'turn-unknown' }
  }
  return endedTurn(turn, {
    turns: [turn],
    end: {
      state: event.state,
      completedAt: event.at,
      ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {})
    }
  })
}

/** The open turn another writer settled: its work ends as the provider's end would end it, and
 *  its row stays as that writer left it. */
export function decideTurnSettled(
  event: Extract<ProviderTimelineDecidedEvent, { type: 'turn.settled' }>
): ProviderTimelineDecision {
  return endedTurn(event.turn)
}

/** The one end of a turn: the journal-derived settlement of its open work, then the state. */
function endedTurn(
  turn: ProviderTimelineTurnRef,
  ending?: ProviderTimelineSettlementEnding
): ProviderTimelineDecision {
  return {
    settle: {
      what: ending ? 'turn-end' : 'turn-settled',
      resolve: (journal) => providerTimelineSettlement(journal, { turnItemId: turn.itemId }, ending)
    },
    commit: (next) => next.endTurn(turn)
  }
}

export function decideInput(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'input.accepted' }>
): ProviderTimelineDecision {
  return decideOpener(
    input,
    {
      userItemId: agentJournalSubmissionKey(event.clientMessageId),
      requestedAt: event.requestedAt
    },
    event.join?.turn
  )
}

/** A saved user message of an adopted session: its own row, only where none is, and the opener of
 *  the turn it names. */
export function decideHistory(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'input.history' }>
): ProviderTimelineDecision {
  const { context, state } = input
  const row = context.rows.item('item', providerKey(event.item), event.join.thread ?? null)
  const write: ProviderTimelineResolvedWrite = { identity: row.identity, body: event.body }
  const opener = decideOpener(input, { userItemId: row.itemId }, event.join.turn)
  return {
    ...opener,
    writes: [
      {
        reservedBytes: estimateStructuredAgentSessionItemBytes(row.identity, event.body),
        lifecycle: false,
        options: { turnScope: providerTimelinePlacement(context, state, event.join) },
        resolve: (at) => (at.itemBody(row.itemId) === null ? write : null)
      },
      ...(opener.writes ?? [])
    ]
  }
}

/** A user message names the turn it opened: the one it names once that one opens, else the open
 *  turn while that still names no message of its own, else the next to open. */
function decideOpener(
  input: ProviderTimelineDecisionInput,
  message: Omit<ProviderTimelinePendingInput, 'turnItemId'>,
  named: string | undefined
): ProviderTimelineDecision {
  const { state, journal, context } = input
  const open = state.open
  const turn = named === undefined ? null : context.rows.turn(providerKey(named))
  if (turn && turn.itemId !== open?.itemId) {
    // A late echo of a turn already over names nothing.
    if (journal && providerTimelineTurnRowState(journal, turn.itemId) !== 'absent') {
      return {}
    }
    return { commit: (next) => next.wait({ ...message, turnItemId: turn.itemId }) }
  }
  if (!open) {
    return { commit: (next) => next.wait(message) }
  }
  const opener =
    (journal && readAgentJournalTurn(journal.itemBody(open.itemId) ?? undefined)?.userItemId) ??
    open.running.userItemId
  if (opener !== open.itemId) {
    return {}
  }
  const running = { ...open.running, ...message }
  return {
    writes: [
      {
        reservedBytes: TURN_ROW_RESERVED_BYTES,
        lifecycle: true,
        options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE, lifecycle: true },
        resolve: (at) => reviseOpener(at, open, message)
      }
    ],
    commit: (next) => {
      if (next.open?.itemId === open.itemId) {
        next.open = { ...next.open, running }
      }
    }
  }
}

/** Only while the row runs and still names the turn itself as its opener: an opener another writer
 *  gave it stands. Every other field is the row's as the journal holds it. */
function reviseOpener(
  journal: StructuredAgentSessionTransitionJournal,
  open: ProviderTimelineOpenTurn,
  message: Omit<ProviderTimelinePendingInput, 'turnItemId'>
): ProviderTimelineResolvedWrite | null {
  const row = readAgentJournalTurn(journal.itemBody(open.itemId) ?? undefined)
  if (row?.state !== 'running' || row.userItemId !== open.itemId) {
    return null
  }
  const target = { identity: open.identity }
  const write = {
    lifecycle: agentJournalTurnBody({ ...row, ...message }),
    onlyWhileRunning: true as const
  }
  return resolveAgentJournalTurnRowWrite(
    journal,
    target,
    write,
    agentJournalTurnRowReservedBytes(target, write)
  )
}

export function decideSessionEnd(
  _input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'session.ended' }>
): ProviderTimelineDecision {
  return {
    settle: {
      what: 'session-end',
      resolve: (journal) =>
        providerTimelineSettlement(journal, 'session', {
          turns: runningProviderTimelineTurns(journal),
          end: event.verdict
        })
    },
    commit: (next) => next.endSession()
  }
}

export function decideContextUsage(
  input: ProviderTimelineDecisionInput,
  event: Extract<ProviderTimelineDecidedEvent, { type: 'context.usage' }>
): ProviderTimelineDecision {
  const { state } = input
  const named = event.join?.turn
  const turn: ProviderTimelineTurnRef | null =
    named === undefined ? (state.open ?? state.latest) : input.context.rows.turn(providerKey(named))
  const target = turn ? { identity: turn.identity } : ({ newest: true } as const)
  const write = { contextUsage: event.usage }
  const usage: ProviderTimelineItemWrite = {
    reservedBytes: agentJournalTurnRowReservedBytes(target, write),
    lifecycle: true,
    options: { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
    resolve: (journal) =>
      resolveAgentJournalTurnRowWrite(
        journal,
        target,
        write,
        agentJournalTurnRowReservedBytes(target, write)
      )
  }
  return { writes: [usage] }
}

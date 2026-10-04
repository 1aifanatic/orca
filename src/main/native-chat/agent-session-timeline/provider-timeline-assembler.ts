// Turns a provider adapter's grammar events (`provider-timeline-event.ts`) into the journal rows
// every structured lane writes.
//
// Division of lifecycle work:
// - The adapter translates its dialect, decides when a turn opens, and re-applies an event the sink
//   refused (the lane runner holds it and pauses reading under backpressure).
// - The assembler plans each event as ONE sink transition. Which row each write lands on, whether
//   a replay writes at all, and every change to what the assembler knows (its ledger) are decided
//   in the transition's resolvers, at the event's turn in the journal's write queue, against the
//   journal as it stands then. So there is one clock: a refused event changed nothing, a write the
//   journal rejects changes nothing, and a restart or an evicted cache finds the same rows again.
// - Planning reads a forecast — the ledger plus what admitted events still in the queue will
//   change — only to answer `apply` at once: dropped or not, over budget or not, the open turn.
// - The journal keeps what it owns: a person's Stop, a dead generation after a restart, and the
//   answer compare-and-set.

import type { AgentType } from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeltaCoalescerDeps } from '../agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type {
  ProviderTimelineApplyHost,
  ProviderTimelineApplyResult,
  ProviderTimelineInFlight
} from './provider-timeline-apply-host'
import {
  PROVIDER_TIMELINE_OVER_BUDGET,
  providerTimelineBudgetAdmits,
  type ProviderTimelineHold
} from './provider-timeline-budget'
import { providerTimelineLedger, type ProviderTimelineContext } from './provider-timeline-context'
import {
  decideProviderTimelineEvent,
  type ProviderTimelineDecidedEvent,
  type ProviderTimelineDecision
} from './provider-timeline-decisions'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import {
  createLegacyProviderTimelineIdentityScheme,
  type ProviderTimelineIdentityScheme
} from './provider-timeline-identity'
import { ProviderTimelineJoins } from './provider-timeline-joins'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { ProviderTimelineState } from './provider-timeline-state'
import {
  applyProviderTimelineTextClose,
  applyProviderTimelineTextDelta
} from './provider-timeline-text-events'
import { ProviderTimelineTextStreams } from './provider-timeline-text-streams'
import {
  planProviderTimelineBarrier,
  planProviderTimelineSlots
} from './provider-timeline-transition-layout'

export type { ProviderTimelineApplyResult } from './provider-timeline-apply-host'
export type { ProviderTimelineDropRule } from './provider-timeline-decisions'

export type ProviderTimelineAssembler = {
  apply(event: ProviderTimelineEvent): ProviderTimelineApplyResult
  /** The turn id of the open turn, as its row and a client's Stop name it. */
  readonly openTurnId: string | null
  /** Writes the text the coalescing window holds. */
  flush(): void
  dispose(): void
}

export type ProviderTimelineAssemblerDeps = {
  sink: ProviderTimelineSink
  sessionId: string
  agent: AgentType
  /** The acquisition: minted keys are unique per generation. */
  generation: string
  /** The provider session whose ids the adapter forwards; the same one again after a restart that
   *  re-attaches it, so its replays are recognised. */
  namespace: string
  /** The session's own provider thread, for providers that run subagents on threads of their own. */
  ownThread?: () => string | null
  /** Defaults to the shared `legacy` identity arm. */
  scheme?: ProviderTimelineIdentityScheme
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function createProviderTimelineAssembler(
  deps: ProviderTimelineAssemblerDeps
): ProviderTimelineAssembler {
  const scheme =
    deps.scheme ??
    createLegacyProviderTimelineIdentityScheme({ agent: deps.agent, sessionId: deps.sessionId })
  let settlements = 0
  const context: ProviderTimelineContext = {
    sessionId: deps.sessionId,
    agent: deps.agent,
    joins: new ProviderTimelineJoins({
      scheme,
      generation: deps.generation,
      namespace: deps.namespace
    }),
    ledger: new ProviderTimelineState(deps.namespace),
    ...(deps.ownThread ? { ownThread: deps.ownThread } : {}),
    settlementId: (what) => {
      settlements += 1
      return `provider-timeline:${deps.sessionId}:${deps.generation}:${settlements}:${what}`
    }
  }
  const streams = new ProviderTimelineTextStreams({
    sink: deps.sink,
    context,
    generation: deps.generation,
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {})
  })
  let forecast = context.ledger.clone()
  const inFlight: ProviderTimelineInFlight[] = []

  /** The forecast again: the ledger, plus what admitted events not yet run will change. */
  const resync = () => {
    forecast = context.ledger.clone()
    for (const entry of inFlight) {
      if (!entry.executed) {
        entry.commit?.(forecast)
      }
    }
  }

  const submit = (
    plan: ProviderTimelinePlan,
    entry: ProviderTimelineInFlight
  ): StructuredAgentSessionSinkAdmission => {
    if (!plan.writes) {
      return plan.submit(deps.sink)
    }
    inFlight.push(entry)
    const settle = () => {
      const at = inFlight.indexOf(entry)
      if (at !== -1) {
        inFlight.splice(at, 1)
        resync()
      }
    }
    const admission = plan.submit(deps.sink, settle)
    if (!admission.accepted) {
      inFlight.splice(inFlight.indexOf(entry), 1)
      return admission
    }
    entry.commit?.(forecast)
    return admission
  }

  const admits = (hold: ProviderTimelineHold): boolean =>
    providerTimelineBudgetAdmits({
      hold,
      forecast,
      ledger: context.ledger,
      streams: streams.open,
      journal: deps.sink.journalItems()
    })

  const host: ProviderTimelineApplyHost = {
    context,
    streams,
    forecast: () => forecast,
    journal: () => deps.sink.journalItems(),
    admits,
    submit
  }

  const applyDecided = (event: ProviderTimelineDecidedEvent): ProviderTimelineApplyResult => {
    const journal = deps.sink.journalItems()
    const decision = decideProviderTimelineEvent(
      { context, state: forecast, journal, execute: false },
      event
    )
    if (decision.dropped) {
      return { admission: ADMITTED, dropped: decision.dropped }
    }
    if (decision.hold && !admits(decision.hold)) {
      return { admission: PROVIDER_TIMELINE_OVER_BUDGET }
    }
    const plan = new ProviderTimelinePlan()
    const entry: ProviderTimelineInFlight = { executed: false, commit: decision.commit }
    let executed: ProviderTimelineDecision | null = null
    // A message boundary is the event's only when its own decision, at execution, wrote.
    const landed = () => executed !== null && !executed.dropped && executed.write !== null
    planProviderTimelineBarrier(host, plan, event, decision, landed)
    // The event's decision on the ledger, taken once, by its first slot to run.
    const decide = (at: StructuredAgentSessionTransitionJournal) => {
      if (!executed) {
        const ledger = providerTimelineLedger(context, at)
        executed = decideProviderTimelineEvent(
          { context, state: ledger, journal: at, execute: true },
          event
        )
        entry.executed = true
        executed.commit?.(ledger)
      }
      return executed.dropped ? null : executed
    }
    planProviderTimelineSlots(host, plan, event, decide)
    if (
      event.type === 'turn.open' ||
      event.type === 'turn.end' ||
      event.type === 'session.ended' ||
      event.type === 'session.reset'
    ) {
      plan.onAdmitted(() => deps.sink.setActivity?.(null))
    }
    return { admission: submit(plan, entry) }
  }

  const apply = (event: ProviderTimelineEvent): ProviderTimelineApplyResult => {
    const journal = deps.sink.journalItems()
    if (journal) {
      forecast.reconcile(journal)
    }
    switch (event.type) {
      case 'text.delta':
        return applyProviderTimelineTextDelta(host, event)
      case 'text.close':
        return applyProviderTimelineTextClose(host, event)
      case 'activity': {
        const open = forecast.open
        if (forecast.ended || !open) {
          return { admission: ADMITTED, dropped: forecast.ended ? 'session-ended' : 'no-turn' }
        }
        deps.sink.setActivity?.(
          event.text === null ? null : { turnId: open.turnId, text: event.text }
        )
        return { admission: ADMITTED }
      }
      case 'turn.open':
        return applyDecided(
          event.turn === undefined ? { ...event, minted: context.joins.mint('t') } : event
        )
      case 'provider.frame':
        return applyDecided({ ...event, minted: context.joins.mint('f') })
      case 'input.accepted':
      case 'input.replayed':
      case 'turn.end':
      case 'item.open':
      case 'item.update':
      case 'item.close':
      case 'request.open':
      case 'request.withdrawn':
      case 'context.usage':
      case 'session.ended':
      case 'session.reset':
        return applyDecided(event)
    }
  }

  return {
    apply,
    get openTurnId() {
      return forecast.open?.turnId ?? null
    },
    flush: () => streams.flush(),
    dispose: () => streams.dispose()
  }
}

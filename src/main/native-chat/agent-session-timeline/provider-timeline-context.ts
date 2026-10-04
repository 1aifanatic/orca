// What every planner and resolver of one assembler shares, and where a joined row goes.

import type {
  AgentJournalProducerLinkage,
  AgentType
} from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineJoin } from './provider-timeline-event'
import type { ProviderTimelineJoins, ProviderTimelinePlacement } from './provider-timeline-joins'
import type { ProviderTimelineState } from './provider-timeline-state'

export type ProviderTimelineContext = {
  sessionId: string
  agent: AgentType
  joins: ProviderTimelineJoins
  /** The truth decisions run on; resolvers only. */
  ledger: ProviderTimelineState
  /** The session's own provider thread; a join naming another thread is subagent work. */
  ownThread?: () => string | null
  /** A settlement id no other settlement of this journal shares. */
  settlementId(what: string): string
}

/** The ledger, with its open turn taken from the journal before its first decision runs. */
export function providerTimelineLedger(
  context: ProviderTimelineContext,
  journal: StructuredAgentSessionTransitionJournal
): ProviderTimelineState {
  if (!context.ledger.hydrated) {
    context.ledger.hydrate(journal)
  }
  return context.ledger
}

/** The turn a new row joins: the one the provider names (subagent work joins the open turn while
 *  keeping its own turn in its identity), else the open one, else none. */
export function providerTimelinePlacement(
  context: ProviderTimelineContext,
  state: ProviderTimelineState,
  join: ProviderTimelineJoin | undefined
): ProviderTimelinePlacement {
  const thread = join?.thread ?? null
  if (join?.turn === undefined) {
    return { thread, turn: state.open?.address.key ?? null, scope: state.scope }
  }
  const key = { source: 'provider', value: join.turn } as const
  const own = context.ownThread?.() ?? null
  const subagent = thread !== null && own !== null && thread !== own
  return {
    thread,
    turn: key,
    scope: subagent
      ? state.scope
      : { kind: 'turn', turnItemId: context.joins.turn(key, state.namespace).itemId }
  }
}

/** What an entry the assembler holds open costs: every provider string it keeps, and its body. */
export function providerTimelineEntryBytes(
  key: string,
  body?: unknown,
  producer?: AgentJournalProducerLinkage
): number {
  const measure = (value: unknown) =>
    value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  return Buffer.byteLength(key, 'utf8') + measure(body) + measure(producer) + 64
}

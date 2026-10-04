// Streamed text, as message rows.
//
// A named stream is the item with that id on its thread, so its deltas, its close and any full
// snapshot of it are one row. An anonymous stream becomes a new message each time it starts, and
// its identity is its name, thread, channel and producer: a change to any starts the next
// message. Deltas accumulate in the shared coalescer, and a row is a snapshot of the text so far.
// Text owed to the journal is written inside the next event's transition — every other event is
// an ordering barrier — or by the coalescer's window, and is marked written once the sink takes it.
//
// Which row a stream writes is decided when its first write runs, like every other row: a
// provider-named message the journal already holds is a message this run is resuming (its turn
// still running: the stream adopts the row's text as its prefix) or a replay (its turn settled, or
// this run closed it: nothing is written).

import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../agent-session-journal/journal-payload-bounds'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../agent-session-wire/agent-session-delta-coalescer'
import { estimateStructuredAgentSessionItemBytes } from '../agent-session-wire/structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  providerTimelineEntryBytes,
  providerTimelineLedger,
  providerTimelinePlacement,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type {
  ProviderTimelineJoin,
  ProviderTimelineTextChannel,
  ProviderTimelineTextItem
} from './provider-timeline-event'
import { providerTimelineKeyPart } from './provider-timeline-identity'
import type { ProviderTimelineItemJoin, ProviderTimelineRow } from './provider-timeline-joins'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import type { ProviderTimelineState } from './provider-timeline-state'

/** One open text stream, as planning knows it. */
export type ProviderTimelineStream = {
  /** Unique per stream: the coalescer's key, and the ledger's for the row it owns. */
  id: string
  /** The stream's slot: a named stream's is its item's join reference, which the budget shares. */
  key: string
  join: ProviderTimelineItemJoin
  /** The turn the provider named, if any. */
  turn: string | undefined
  /** The turn planning expects its row in, so a turn's end releases it. */
  turnItemId: string | null
  named: boolean
  channel: ProviderTimelineTextChannel
  producer: AgentJournalProducerLinkage | undefined
  /** Whether any text was written; a whitespace-only stream completes nothing. */
  written: boolean
  bytes: number
}

/** The row a stream writes, and the text it held before this run streamed into it. */
type Owned = { row: ProviderTimelineRow; prefix: string } | 'replayed'

type Resolved = {
  identity: ProviderTimelineRow['identity']
  body: AgentJournalItemBody
  options: StructuredAgentSessionItemAppendOptions
}

export function providerTimelineMessageText(body: AgentJournalItemBody | null): string {
  return body?.kind === 'message' && body.blocks[0]?.type === 'text' ? body.blocks[0].text : ''
}

export class ProviderTimelineTextStreams {
  private readonly streams = new Map<string, ProviderTimelineStream>()
  private readonly byId = new Map<string, ProviderTimelineStream>()
  /** Ledger: the row each stream writes, decided by its first write. */
  private readonly owned = new Map<string, Owned>()
  private readonly coalescer
  private serial = 0

  constructor(
    private readonly deps: {
      sink: ProviderTimelineSink
      context: ProviderTimelineContext
      generation: string
      coalesceMs?: number
      schedule?: AgentSessionDeltaCoalescerDeps['schedule']
    }
  ) {
    this.coalescer = createAgentSessionDeltaCoalescer({
      ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
      ...(deps.schedule ? { schedule: deps.schedule } : {}),
      // Every stream here is one this assembler holds open; the shared budget counts them.
      isProtected: () => true,
      emit: (id, text) => this.flushOnWindow(id, text)
    })
  }

  /** What the budget counts: one entry per open stream. */
  get open(): readonly ProviderTimelineStream[] {
    return [...this.streams.values()]
  }

  /** The stream slot `item` names on its thread. */
  key(
    item: ProviderTimelineTextItem,
    join: ProviderTimelineJoin | undefined,
    state: ProviderTimelineState
  ): string {
    return 'id' in item
      ? this.deps.context.joins.reference(this.itemJoin(item, join), state.namespace)
      : `stream:${providerTimelineKeyPart(join?.thread ?? '')}:${providerTimelineKeyPart(item.stream)}`
  }

  get(key: string): ProviderTimelineStream | undefined {
    return this.streams.get(key)
  }

  /** A new stream; the caller has checked the budget for its `bytes`. */
  start(input: {
    item: ProviderTimelineTextItem
    join: ProviderTimelineJoin | undefined
    channel: ProviderTimelineTextChannel
    producer: AgentJournalProducerLinkage | undefined
    state: ProviderTimelineState
  }): ProviderTimelineStream {
    this.serial += 1
    const named = 'id' in input.item
    const join = named ? this.itemJoin(input.item, input.join) : this.anonymousJoin(input.join)
    const placement = providerTimelinePlacement(this.deps.context, input.state, input.join)
    return {
      id: `${this.deps.generation}:s${this.serial}`,
      key: this.key(input.item, input.join, input.state),
      join,
      turn: input.join?.turn,
      turnItemId: placement.scope.kind === 'turn' ? placement.scope.turnItemId : null,
      named,
      channel: input.channel,
      producer: input.producer,
      written: false,
      bytes: providerTimelineEntryBytes(
        'id' in input.item ? input.item.id : input.item.stream,
        undefined,
        input.producer
      )
    }
  }

  /** Whether a delta on `stream` continues it or begins another message. */
  continues(
    stream: ProviderTimelineStream,
    channel: ProviderTimelineTextChannel,
    producer: AgentJournalProducerLinkage | undefined
  ): boolean {
    return stream.channel === channel && stream.producer?.agentId === producer?.agentId
  }

  /** The delta's text; the stream opens when the event is admitted. */
  planAppend(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, text: string): void {
    plan.onAdmitted(() => {
      if (!this.byId.has(stream.id)) {
        this.streams.set(stream.key, stream)
        this.byId.set(stream.id, stream)
      }
      this.coalescer.append(stream.id, text)
    })
  }

  /** Every stream's unwritten text, ahead of whatever the event writes. */
  planFlush(plan: ProviderTimelinePlan, except?: ProviderTimelineStream): void {
    for (const { key, snapshot } of this.coalescer.dirty()) {
      const stream = this.byId.get(key)
      if (stream && stream !== except) {
        this.planText(plan, stream, snapshot.text)
      }
    }
  }

  /** Ends the streams `which` selects; their text was flushed by the same event. */
  planRelease(
    plan: ProviderTimelinePlan,
    which: (stream: ProviderTimelineStream) => boolean
  ): void {
    const released = [...this.streams.values()].filter(which)
    if (released.length === 0) {
      return
    }
    plan.onAdmitted(() => released.forEach((stream) => this.forget(stream)))
    plan.atExecution(() => released.forEach((stream) => this.owned.delete(stream.id)))
  }

  /** Ends one stream with the provider's final text, else what streamed; it settles the item. */
  planClose(plan: ProviderTimelinePlan, stream: ProviderTimelineStream, finalText?: string): void {
    if (finalText === undefined) {
      const owed = this.coalescer.dirty().find(({ key }) => key === stream.id)
      if (owed) {
        this.planText(plan, stream, owed.snapshot.text)
      }
    } else {
      this.planText(
        plan,
        stream,
        boundInlineText(finalText, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text,
        true
      )
    }
    this.planRelease(plan, (each) => each === stream)
    if (stream.named) {
      // The close settles the item for full snapshots too.
      plan.atExecution(() => {
        const owned = this.owned.get(stream.id)
        const row = owned && owned !== 'replayed' ? owned.row : null
        this.deps.context.ledger.closed.set(
          stream.key,
          row?.scope.kind === 'turn' ? row.scope.turnItemId : null
        )
      })
    }
  }

  flush(): void {
    this.coalescer.flushAll()
  }

  dispose(): void {
    this.open.forEach((stream) => this.forget(stream))
    this.owned.clear()
    this.coalescer.dispose()
  }

  /** The window's flush: false keeps the text for a retry, but only while the sink is merely full. */
  private flushOnWindow(id: string, text: string): boolean {
    const stream = this.byId.get(id)
    if (!stream) {
      return true
    }
    const plan = new ProviderTimelinePlan()
    this.planText(plan, stream, text)
    const admission: StructuredAgentSessionSinkAdmission = plan.submit(this.deps.sink)
    // A failed or closed sink can never take it; the session's end owns what it leaves.
    return admission.accepted || admission.reason !== 'backpressure'
  }

  private planText(
    plan: ProviderTimelinePlan,
    stream: ProviderTimelineStream,
    text: string,
    providerFinal = false
  ): void {
    const empty = providerFinal ? text.length === 0 : text.trim().length === 0
    if (!stream.written && empty) {
      plan.onAdmitted(() => this.coalescer.markFlushed(stream.id))
      return
    }
    const placeholder = this.message(stream, text)
    plan.item({
      // Room for the text and the longest identity a scheme spells; a resumed prefix only paces.
      reservedBytes: estimateStructuredAgentSessionItemBytes(
        { provider: 'orca', clientMessageId: 'x'.repeat(1024) },
        placeholder
      ),
      paced: true,
      resolve: (journal) => this.resolveText(stream, text, providerFinal, journal),
      options: { ...stream.producer, turnScope: { kind: 'thread' } }
    })
    plan.onAdmitted(() => {
      stream.written = true
      this.coalescer.markFlushed(stream.id)
    })
  }

  /** At the write's turn in the queue: the row the stream owns, and its text so far. */
  private resolveText(
    stream: ProviderTimelineStream,
    text: string,
    providerFinal: boolean,
    journal: StructuredAgentSessionTransitionJournal
  ): Resolved | null {
    const ledger = providerTimelineLedger(this.deps.context, journal)
    let owned = this.owned.get(stream.id)
    if (!owned) {
      owned = this.own(stream, ledger, journal)
      this.owned.set(stream.id, owned)
    }
    if (owned === 'replayed' || ledger.ended) {
      return null
    }
    const { row, prefix } = owned
    return {
      identity: row.identity,
      body: this.message(stream, providerFinal ? text : `${prefix}${text}`),
      options: {
        ...stream.producer,
        turnScope: row.scope,
        ...(row.ref === undefined ? {} : { providerItemRef: row.ref })
      }
    }
  }

  private own(
    stream: ProviderTimelineStream,
    ledger: ProviderTimelineState,
    journal: StructuredAgentSessionTransitionJournal
  ): Owned {
    const { joins } = this.deps.context
    if (stream.named && ledger.closed.has(stream.key)) {
      return 'replayed'
    }
    const found = stream.named ? joins.find(stream.join, journal) : null
    if (found) {
      const turnItemId = found.scope.kind === 'turn' ? found.scope.turnItemId : null
      if (turnItemId !== null && ledger.status({ itemId: turnItemId }, journal) === 'settled') {
        return 'replayed'
      }
      return { row: found, prefix: providerTimelineMessageText(journal.itemBody(found.itemId)) }
    }
    const placement = providerTimelinePlacement(this.deps.context, ledger, {
      ...(stream.join.thread === null ? {} : { thread: stream.join.thread }),
      ...(stream.turn === undefined ? {} : { turn: stream.turn })
    })
    const itemClass = stream.channel === 'assistant' ? 'message' : 'reasoning'
    return { row: joins.place(stream.join, itemClass, placement, journal), prefix: '' }
  }

  private message(stream: ProviderTimelineStream, text: string): AgentJournalItemBody {
    return {
      kind: 'message',
      role: stream.channel === 'assistant' ? 'assistant' : 'reasoning',
      blocks: [{ type: 'text', text }]
    }
  }

  private itemJoin(item: { id: string }, join?: ProviderTimelineJoin): ProviderTimelineItemJoin {
    return {
      family: 'item',
      key: { source: 'provider', value: item.id },
      thread: join?.thread ?? null
    }
  }

  private anonymousJoin(join?: ProviderTimelineJoin): ProviderTimelineItemJoin {
    return { family: 'item', key: this.deps.context.joins.mint('s'), thread: join?.thread ?? null }
  }

  private forget(stream: ProviderTimelineStream): void {
    this.coalescer.forget(stream.id)
    if (this.streams.get(stream.key) === stream) {
      this.streams.delete(stream.key)
    }
    this.byId.delete(stream.id)
  }
}

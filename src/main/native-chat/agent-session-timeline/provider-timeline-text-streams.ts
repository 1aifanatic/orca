// Streamed text, as message rows.
//
// A named stream is the item with that id on its thread, so its deltas, its close and any full
// snapshot of it are one row. An anonymous stream becomes a new message each time it starts, and
// its identity is its name, thread, channel and producer: a change to any starts the next
// message. Deltas accumulate in the shared coalescer, and a row is a snapshot of the text so far.
// Text owed to the journal is written inside the next event's transition — every other event is
// an ordering barrier — or by the coalescer's window, and is marked written once the sink takes it.
// Which row each write lands on is the journal's call, at the write (`provider-timeline-stream-rows.ts`).

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
  providerTimelinePlacement,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type {
  ProviderTimelineJoin,
  ProviderTimelineTextChannel,
  ProviderTimelineTextItem
} from './provider-timeline-event'
import { BoundedMap } from '../../../shared/bounded-map'
import { providerTimelineKeyPart } from './provider-timeline-identity'
import type { ProviderTimelineItemJoin, ProviderTimelineRow } from './provider-timeline-joins'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { ProviderTimelineStreamRows } from './provider-timeline-stream-rows'
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
  /** The anonymous stream an event released just before this one began: this one continues its
   *  row unless that event's boundary landed. */
  follows?: ProviderTimelineStream
  /** Execution: whether the event that released this stream ended its message. */
  boundary?: 'held' | 'void'
}

type Resolved = {
  identity: ProviderTimelineRow['identity']
  body: AgentJournalItemBody
  options: StructuredAgentSessionItemAppendOptions
}

export class ProviderTimelineTextStreams {
  private readonly streams = new Map<string, ProviderTimelineStream>()
  private readonly byId = new Map<string, ProviderTimelineStream>()
  private readonly rows: ProviderTimelineStreamRows
  /** Per anonymous slot, the stream a boundary not yet decided released last. */
  private readonly released = new BoundedMap<string, ProviderTimelineStream>({ maxEntries: 64 })
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
    this.rows = new ProviderTimelineStreamRows(deps.context, (stream) => this.forget(stream))
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
    const join =
      'id' in input.item ? this.itemJoin(input.item, input.join) : this.anonymousJoin(input.join)
    const placement = providerTimelinePlacement(this.deps.context, input.state, input.join)
    const key = this.key(input.item, input.join, input.state)
    const follows = named ? undefined : this.released.get(key)
    this.released.delete(key)
    return {
      id: `${this.deps.generation}:s${this.serial}`,
      key,
      ...(follows ? { follows } : {}),
      join,
      turn: input.join?.turn,
      turnItemId: placement.scope.kind === 'turn' ? placement.scope.turnItemId : null,
      named,
      channel: input.channel,
      producer: input.producer,
      written: false,
      bytes: providerTimelineEntryBytes({
        key: 'id' in input.item ? input.item.id : input.item.stream,
        join: input.join,
        producer: input.producer
      })
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

  /** Ends the streams `which` selects; their text was flushed by the same event. Planning starts
   *  the next message at once; `landed`, asked at execution, says whether the event really ended
   *  them: when it did not (a replay the journal held), the next anonymous message continues
   *  this one's row, and a named stream's next delta resumes its row from the journal. */
  planRelease(
    plan: ProviderTimelinePlan,
    which: (stream: ProviderTimelineStream) => boolean,
    landed?: () => boolean
  ): void {
    const released = [...this.streams.values()].filter(which)
    if (released.length === 0) {
      return
    }
    plan.onAdmitted(() =>
      released.forEach((stream) => {
        this.forget(stream)
        if (landed && !stream.named) {
          this.released.set(stream.key, stream)
        }
      })
    )
    plan.atExecution(() =>
      released.forEach((stream) => this.rows.release(stream, !landed || landed()))
    )
  }

  /** At a turn's or the session's end: every stream whose row is over now stops. */
  planRetire(plan: ProviderTimelinePlan): void {
    plan.atExecution((journal) => this.rows.retire(this.open, journal))
  }

  /** The turn a stream's row is in, once a write placed it; else the one planning expects. */
  rowTurn(stream: ProviderTimelineStream): string | null {
    return this.rows.turn(stream)
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
    if (stream.named) {
      // The close settles the item for full snapshots too, in the turn its row is in.
      plan.atExecution(() =>
        this.deps.context.ledger.closed.set(stream.key, this.rows.turn(stream))
      )
    }
    this.planRelease(plan, (each) => each === stream)
  }

  flush(): void {
    this.coalescer.flushAll()
  }

  dispose(): void {
    this.open.forEach((stream) => this.forget(stream))
    this.rows.clear()
    this.released.clear()
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
    const owned = this.rows.resolve(stream, journal)
    if (!owned) {
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

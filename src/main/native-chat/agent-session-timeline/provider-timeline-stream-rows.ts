// The ledger of which row each text stream writes, changed only at its writes' turn in the queue.
//
// A stream's row is decided by its first write, like every other row: a provider-named message
// the journal already holds is one this run resumes (its turn still running: the stream adopts the
// row's text as its prefix) or a replay (its turn settled, or this run closed it: nothing is
// written). An anonymous stream continues the row of the one before it when the event that ended
// that one turned out a replay. Every later write checks again that the row is not over, against
// the journal, so a turn another writer ended stops the stream there too.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  providerTimelineLedger,
  providerTimelinePlacement,
  type ProviderTimelineContext
} from './provider-timeline-context'
import { turnOf } from './provider-timeline-decision'
import type { ProviderTimelineRow } from './provider-timeline-joins'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineStream } from './provider-timeline-text-streams'

/** The row a stream writes, and the text it held before this run streamed into it. */
export type ProviderTimelineStreamRow = { row: ProviderTimelineRow; prefix: string }

type Owned = ProviderTimelineStreamRow | 'replayed'

function providerTimelineMessageText(body: AgentJournalItemBody | null): string {
  return body?.kind === 'message' && body.blocks[0]?.type === 'text' ? body.blocks[0].text : ''
}

export class ProviderTimelineStreamRows {
  private readonly owned = new Map<string, Owned>()

  constructor(
    private readonly context: ProviderTimelineContext,
    /** Drops a stream planning still holds open, so its next delta starts another. */
    private readonly forget: (stream: ProviderTimelineStream) => void
  ) {}

  /** At a write: the row it lands on, or null when it writes nothing. */
  resolve(
    stream: ProviderTimelineStream,
    journal: StructuredAgentSessionTransitionJournal
  ): ProviderTimelineStreamRow | null {
    const ledger = providerTimelineLedger(this.context, journal)
    let owned = this.owned.get(stream.id)
    if (!owned) {
      owned = this.own(stream, ledger, journal)
      this.owned.set(stream.id, owned)
    }
    if (owned === 'replayed' || ledger.ended) {
      return null
    }
    // Every write, not only the first: whoever ended the row's turn since, this run or another
    // writer of the journal, the stream never writes into it again.
    if (this.over(stream, owned.row, ledger, journal)) {
      this.stop(stream)
      return null
    }
    return owned
  }

  /** The event that released `stream` ran: `held` when it really ended the stream's message. */
  release(stream: ProviderTimelineStream, held: boolean): void {
    stream.boundary = held ? 'held' : 'void'
    // A named stream's next delta finds its row again through the journal; an anonymous one is
    // kept for the stream that follows it.
    if (held || stream.named) {
      this.owned.delete(stream.id)
    }
  }

  /** Stops every stream whose row is over now. */
  retire(
    streams: readonly ProviderTimelineStream[],
    journal: StructuredAgentSessionTransitionJournal
  ): void {
    const ledger = providerTimelineLedger(this.context, journal)
    for (const stream of streams) {
      const owned = this.owned.get(stream.id)
      if (owned && owned !== 'replayed' && this.over(stream, owned.row, ledger, journal)) {
        this.stop(stream)
      }
    }
  }

  /** The turn the stream's row is in, once a write placed it; else the one planning expects. */
  turn(stream: ProviderTimelineStream): string | null {
    const owned = this.owned.get(stream.id)
    return owned && owned !== 'replayed' ? turnOf(owned.row.scope) : stream.turnItemId
  }

  clear(): void {
    this.owned.clear()
  }

  private own(
    stream: ProviderTimelineStream,
    ledger: ProviderTimelineState,
    journal: StructuredAgentSessionTransitionJournal
  ): Owned {
    const { joins } = this.context
    if (stream.named && ledger.closed.has(stream.key)) {
      return 'replayed'
    }
    const carried = this.carried(stream, journal)
    if (carried) {
      return carried
    }
    const found = stream.named ? joins.find(stream.join, journal) : null
    if (found) {
      const turnItemId = turnOf(found.scope)
      if (turnItemId !== null && ledger.status({ itemId: turnItemId }, journal) === 'settled') {
        return 'replayed'
      }
      return { row: found, prefix: providerTimelineMessageText(journal.itemBody(found.itemId)) }
    }
    const placement = providerTimelinePlacement(this.context, ledger, {
      ...(stream.join.thread === null ? {} : { thread: stream.join.thread }),
      ...(stream.turn === undefined ? {} : { turn: stream.turn })
    })
    const itemClass = stream.channel === 'assistant' ? 'message' : 'reasoning'
    return { row: joins.place(stream.join, itemClass, placement, journal), prefix: '' }
  }

  /** The row of the message this one continues: an earlier anonymous stream whose release the
   *  journal did not take (its event was a replay). */
  private carried(
    stream: ProviderTimelineStream,
    journal: StructuredAgentSessionTransitionJournal
  ): Owned | null {
    let previous = stream.follows
    delete stream.follows
    for (; previous?.boundary === 'void'; previous = previous.follows) {
      const owned = this.owned.get(previous.id)
      if (owned) {
        this.owned.delete(previous.id)
        return owned === 'replayed'
          ? owned
          : {
              row: owned.row,
              prefix: providerTimelineMessageText(journal.itemBody(owned.row.itemId))
            }
      }
    }
    return null
  }

  /** Whether the row is past streaming into: its item closed, or its turn settled. */
  private over(
    stream: ProviderTimelineStream,
    row: ProviderTimelineRow,
    ledger: ProviderTimelineState,
    journal: StructuredAgentSessionTransitionJournal
  ): boolean {
    const turn = turnOf(row.scope)
    return (
      (stream.named && ledger.closed.has(stream.key)) ||
      (turn !== null && ledger.status({ itemId: turn }, journal) === 'settled')
    )
  }

  /** The stream writes nothing more; a later delta under its key starts another. */
  private stop(stream: ProviderTimelineStream): void {
    this.owned.set(stream.id, 'replayed')
    this.forget(stream)
  }
}

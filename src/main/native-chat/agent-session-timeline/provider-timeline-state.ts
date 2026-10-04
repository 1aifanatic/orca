// What the assembler knows about the session, held twice.
//
// The ledger is the truth the decisions run on: it changes only inside transition resolvers, at
// each event's turn in the journal's write queue, and everything in it is either a cache of the
// journal (re-derived from the fold when missing) or this run's own memory (items it closed, the
// sends waiting for a turn). The forecast is a copy plus what admitted events still in the queue
// are expected to change; it only answers `apply` before those events land, and is rebuilt from
// the ledger as they do.

import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { BoundedMap } from '../../../shared/bounded-map'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineTurnRef } from './provider-timeline-joins'

/** Closed items remembered so a repeat close is dropped and an open reopens; past this, the
 *  journal decides from the row alone. */
const MAX_CLOSED_ITEMS = 512
/** Turns remembered as settled without asking the journal. */
const MAX_SETTLED_TURNS = 256
/** Sends waiting for a turn; a provider that never opens one cannot grow this without bound. */
const MAX_PENDING_INPUTS = 64
const MAX_PENDING_INPUT_BYTES = 64 * 1024

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export type ProviderTimelineOpenTurn = ProviderTimelineTurnRef & {
  running: AgentJournalTurnLifecycle
}

export type ProviderTimelinePendingInput = {
  clientMessageId: string
  requestedAt: number
  /** The turn row the provider said the send opens; absent: the next turn to open. */
  turnItemId?: string
}

/** Work still waiting on a row that settles it: a running tool or a pending request. Keyed by
 *  the item's join reference (a request's by its key, whatever its incarnation). */
export type ProviderTimelineObligation = {
  /** The row, once a resolver placed it. */
  itemId: string | null
  /** The turn whose end settles it; null for a row in no turn. */
  turnItemId: string | null
  bytes: number
}

export type ProviderTimelineTurnStatus = 'absent' | 'running' | 'settled'

export class ProviderTimelineState {
  ended = false
  open: ProviderTimelineOpenTurn | null = null
  latest: ProviderTimelineTurnRef | null = null
  inputs: ProviderTimelinePendingInput[] = []
  /** Items this run closed, with the turn they closed in. */
  closed = new BoundedMap<string, string | null>({
    maxEntries: MAX_CLOSED_ITEMS,
    maxBytes: MAX_CLOSED_ITEMS * 1024,
    sizeOf: (turnItemId, ref) => bytes(ref) + bytes(turnItemId ?? '') + 16
  })
  settled = new BoundedMap<string, true>({
    maxEntries: MAX_SETTLED_TURNS,
    maxBytes: MAX_SETTLED_TURNS * 1024,
    sizeOf: (_settled, turnItemId) => bytes(turnItemId) + 8
  })
  obligations = new Map<string, ProviderTimelineObligation>()
  /** Whether the open turn was taken from the journal yet (ledger only). */
  hydrated = false

  constructor(public namespace: string) {}

  get scope(): AgentJournalTurnScope {
    return this.open ? { kind: 'turn', turnItemId: this.open.itemId } : AGENT_JOURNAL_THREAD_SCOPE
  }

  clone(): ProviderTimelineState {
    const copy = new ProviderTimelineState(this.namespace)
    copy.ended = this.ended
    copy.open = this.open && { ...this.open }
    copy.latest = this.latest
    copy.inputs = [...this.inputs]
    for (const [key, value] of this.closed.entries()) {
      copy.closed.set(key, value)
    }
    for (const [key, value] of this.settled.entries()) {
      copy.settled.set(key, value)
    }
    copy.obligations = new Map(this.obligations)
    copy.hydrated = this.hydrated
    return copy
  }

  /** Settled once anything settled it: this run, or any writer of the journal (a person's Stop).
   *  Memory says only what the journal cannot yet: a turn opened by a write still queued. */
  status(
    turn: { itemId: string },
    journal: StructuredAgentSessionTransitionJournal | null
  ): ProviderTimelineTurnStatus {
    if (this.settled.has(turn.itemId)) {
      return 'settled'
    }
    const row = readAgentJournalTurn(journal?.itemBody(turn.itemId) ?? undefined)
    if (row) {
      return row.state === 'running' ? 'running' : 'settled'
    }
    return this.open?.itemId === turn.itemId ? 'running' : 'absent'
  }

  /** Ends the open turn when the journal holds it settled: another writer ended it. */
  reconcile(journal: StructuredAgentSessionTransitionJournal): void {
    if (!this.hydrated) {
      this.hydrate(journal)
    }
    const row = this.open && readAgentJournalTurn(journal.itemBody(this.open.itemId) ?? undefined)
    if (this.open && row && row.state !== 'running') {
      this.endTurn(this.open)
    }
  }

  /** A send waiting for its turn; past the bounds the oldest is forgotten (its turn opens as the
   *  provider's own). */
  wait(pending: ProviderTimelinePendingInput): void {
    this.inputs.push(pending)
    const size = (input: ProviderTimelinePendingInput) =>
      bytes(input.clientMessageId) + bytes(input.turnItemId ?? '') + 16
    let held = this.inputs.reduce((total, input) => total + size(input), 0)
    while (this.inputs.length > MAX_PENDING_INPUTS || held > MAX_PENDING_INPUT_BYTES) {
      const forgotten = this.inputs.shift()
      if (!forgotten) {
        return
      }
      held -= size(forgotten)
    }
  }

  /** The send that opens `turnItemId`: the one that named it, else the oldest that named none. */
  opener(turnItemId: string): ProviderTimelinePendingInput | undefined {
    return (
      this.inputs.find((input) => input.turnItemId === turnItemId) ??
      this.inputs.find((input) => input.turnItemId === undefined)
    )
  }

  /** The turn is over, and so is everything its settlement covered. */
  endTurn(turn: ProviderTimelineTurnRef): void {
    if (this.open?.itemId === turn.itemId) {
      this.open = null
    }
    this.latest = turn
    this.settled.set(turn.itemId, true)
    for (const [key, obligation] of this.obligations) {
      if (obligation.turnItemId === turn.itemId) {
        this.obligations.delete(key)
      }
    }
    // A settled turn's rows are judged by the turn now.
    for (const [key, turnItemId] of this.closed.entries()) {
      if (turnItemId === turn.itemId) {
        this.closed.delete(key)
      }
    }
  }

  /** The session is over: nothing it held is open any more. */
  endSession(): void {
    this.open = null
    this.obligations.clear()
    this.closed.clear()
  }

  reset(namespace: string): void {
    this.namespace = namespace
    this.ended = false
    this.open = null
    this.latest = null
    this.inputs = []
    this.obligations.clear()
    this.closed.clear()
    this.settled.clear()
  }

  /** Takes the open turn from the journal: the newest turn row it holds running. Its key is the
   *  turn id the row carries, which is the provider's own turn id for a scheme that spells it. */
  hydrate(journal: StructuredAgentSessionTransitionJournal): void {
    this.hydrated = true
    if (this.open) {
      return
    }
    let newest = -1
    journal.visitItems((itemId, sequence, body) => {
      const running = readAgentJournalTurn(body)
      const identity = running?.state === 'running' ? parseAgentJournalItemKey(itemId) : null
      if (!running || !identity || sequence < newest) {
        return
      }
      newest = sequence
      this.open = {
        address: {
          namespace: this.namespace,
          key: { source: 'provider', value: running.turnId }
        },
        identity,
        itemId,
        turnId: running.turnId,
        running
      }
    })
  }
}

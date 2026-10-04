// Provider joins → journal rows: the assembler's canonical join index.
//
// Every row the assembler writes is found again through here, and every entry is a cache of a
// fact the journal holds. A row whose identity spells its provider key is found by recomputing
// that identity; a row whose identity does not (a message keyed by its place among its turn's
// messages) carries the key as `providerItemRef`, which the journal indexes. So a miss — after a
// restart or an eviction — recovers the original row; it never re-places it. Message ordinals and
// request incarnations are read back from the rows that hold them. Only transition resolvers call
// the allocating members, so allocation happens in journal order and a refused event allocates
// nothing.

import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalRenderItem,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { BoundedMap } from '../../../shared/bounded-map'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  providerTimelineKeyPart,
  spellProviderTimelineKey,
  type ProviderTimelineIdentityScheme,
  type ProviderTimelineItemAddress,
  type ProviderTimelineItemClass,
  type ProviderTimelineItemFamily,
  type ProviderTimelineKey,
  type ProviderTimelineTurnAddress
} from './provider-timeline-identity'

const MAX_JOINED_ROWS = 1_024
const MAX_JOINED_ROW_BYTES = 1024 * 1024
const MAX_TURN_ORDINALS = 256
/** Echoed sends whose slot no row holds yet; a lane records each on its send soon after. */
const MAX_RESERVED_ECHOES = 64

/** One provider item as the provider names it. Item keys are the provider's per thread. */
export type ProviderTimelineItemJoin = {
  family: ProviderTimelineItemFamily
  key: ProviderTimelineKey
  thread: string | null
}

export type ProviderTimelineRow = {
  identity: AgentJournalItemIdentity
  itemId: string
  scope: AgentJournalTurnScope
  /** The join's reference, on a row whose identity does not spell its key. */
  ref?: string
  /** Which request under its key, 1 for the first. */
  incarnation: number
}

export type ProviderTimelineTurnRef = {
  address: ProviderTimelineTurnAddress
  identity: AgentJournalItemIdentity
  itemId: string
  turnId: string
}

/** Where a new row goes: the provider thread and turn, and the journal turn scope. */
export type ProviderTimelinePlacement = {
  thread: string | null
  turn: ProviderTimelineKey | null
  scope: AgentJournalTurnScope
}

type Journal = StructuredAgentSessionTransitionJournal | null

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export class ProviderTimelineJoins {
  private readonly rows = new BoundedMap<string, ProviderTimelineRow>({
    maxEntries: MAX_JOINED_ROWS,
    maxBytes: MAX_JOINED_ROW_BYTES,
    sizeOf: (row, key) => bytes(key) + 2 * bytes(row.itemId) + 64
  })
  private readonly ordinals = new BoundedMap<string, number>({
    maxEntries: MAX_TURN_ORDINALS,
    maxBytes: MAX_TURN_ORDINALS * 1024,
    sizeOf: (_next, place) => bytes(place) + 8
  })
  private readonly echoes = new BoundedMap<string, true>({ maxEntries: MAX_RESERVED_ECHOES })
  private serial = 0

  constructor(
    private readonly deps: {
      scheme: ProviderTimelineIdentityScheme
      generation: string
      namespace: string
    }
  ) {}

  get namespace(): string {
    return this.deps.namespace
  }

  /** A new provider session: its ids name new rows. Minted keys stay unique as they are. */
  reset(namespace: string): void {
    this.deps.namespace = namespace
    this.rows.clear()
    this.ordinals.clear()
  }

  /** A key unique to this acquisition, for something the provider names nothing. */
  mint(kind: string): ProviderTimelineKey {
    this.serial += 1
    return { source: 'minted', value: `${this.deps.generation}:${kind}${this.serial}` }
  }

  /** A turn's row. `namespace` defaults to the current one; a planner names the one it expects. */
  turn(key: ProviderTimelineKey, namespace = this.deps.namespace): ProviderTimelineTurnRef {
    const address = { namespace, key }
    const identity = this.deps.scheme.turn(address)
    return {
      address,
      identity,
      itemId: agentJournalItemKey(identity),
      turnId: this.deps.scheme.turnId(address)
    }
  }

  /** The user item a turn names when no send of Orca's opened it. */
  turnOpener(turn: ProviderTimelineTurnRef): string {
    return this.deps.scheme.turnOpener?.(turn.address) ?? turn.itemId
  }

  /** The join as one bounded string: what rows carry as `providerItemRef` and caches key by. */
  reference(join: ProviderTimelineItemJoin, namespace = this.deps.namespace): string {
    const thread = join.family === 'request' ? null : join.thread
    return `${join.family}:${spellProviderTimelineKey(namespace, join.key, thread)}`
  }

  /** The row the join already names, from memory or the fold; null when the journal holds none. */
  find(
    join: ProviderTimelineItemJoin,
    journal: Journal,
    namespace = this.deps.namespace
  ): ProviderTimelineRow | null {
    const ref = this.reference(join, namespace)
    const cached = this.rows.get(ref)
    // A planner ahead of a reset asks about a namespace whose rows this index does not spell yet.
    if (cached || !journal || namespace !== this.deps.namespace) {
      return cached ?? null
    }
    const itemId =
      journal.itemIdForProviderItemRef(ref) ?? agentJournalItemKey(this.spelled(join, 1))
    const row = rowOf(journal.item(itemId), 1)
    if (row) {
      this.rows.set(ref, row)
    }
    return row
  }

  /** A new row for a join no row names yet. Allocates its message ordinal: resolvers only. */
  place(
    join: ProviderTimelineItemJoin,
    itemClass: ProviderTimelineItemClass,
    placement: ProviderTimelinePlacement,
    journal: Journal
  ): ProviderTimelineRow {
    const ordinal = this.ordinalFor(itemClass, placement, journal)
    const identity = this.deps.scheme.item({
      ...this.address(join, 1),
      turn: placement.turn,
      itemClass,
      messageOrdinal: ordinal
    })
    const ref = this.reference(join)
    const row: ProviderTimelineRow = {
      identity,
      itemId: agentJournalItemKey(identity),
      scope: placement.scope,
      ...(ordinal === null ? {} : { ref }),
      incarnation: 1
    }
    this.rows.set(ref, row)
    return row
  }

  /** An echoed send takes its message's place without a row (its send is the bubble). */
  reserveEcho(
    join: ProviderTimelineItemJoin,
    placement: ProviderTimelinePlacement,
    journal: Journal
  ) {
    if (!this.deps.scheme.ordinalMessages || !placement.turn || this.find(join, journal)) {
      return
    }
    const row = this.place(join, 'message', placement, journal)
    this.echoes.set(row.itemId, true)
  }

  /** The request under `key` the journal holds last: the highest incarnation with a row. */
  request(
    key: ProviderTimelineKey,
    journal: Journal,
    namespace = this.deps.namespace
  ): ProviderTimelineRow | null {
    const join = { family: 'request' as const, key, thread: null }
    const ref = this.reference(join, namespace)
    const cached = this.rows.get(ref)
    if (cached || !journal || namespace !== this.deps.namespace) {
      return cached ?? null
    }
    let current: ProviderTimelineRow | null = null
    for (let incarnation = 1; ; incarnation += 1) {
      const itemId = agentJournalItemKey(this.spelled(join, incarnation))
      // A scheme that spells no incarnation names one row for every request under the key.
      const row = itemId === current?.itemId ? null : rowOf(journal.item(itemId), incarnation)
      if (!row) {
        break
      }
      current = row
    }
    if (current) {
      this.rows.set(ref, current)
    }
    return current
  }

  /** The next request under `key`: resolvers only. */
  nextRequest(
    key: ProviderTimelineKey,
    itemClass: ProviderTimelineItemClass,
    placement: ProviderTimelinePlacement,
    journal: Journal
  ): ProviderTimelineRow {
    const join = { family: 'request' as const, key, thread: null }
    const incarnation = (this.request(key, journal)?.incarnation ?? 0) + 1
    const identity = this.deps.scheme.item({
      ...this.address(join, incarnation),
      thread: placement.thread,
      turn: placement.turn,
      itemClass
    })
    const row = {
      identity,
      itemId: agentJournalItemKey(identity),
      scope: placement.scope,
      incarnation
    }
    this.rows.set(this.reference(join), row)
    return row
  }

  private address(
    join: ProviderTimelineItemJoin,
    incarnation: number
  ): ProviderTimelineItemAddress {
    return {
      namespace: this.deps.namespace,
      family: join.family,
      key: join.key,
      thread: join.thread,
      turn: null,
      itemClass: 'status',
      messageOrdinal: null,
      incarnation
    }
  }

  private spelled(join: ProviderTimelineItemJoin, incarnation: number): AgentJournalItemIdentity {
    return this.deps.scheme.item(this.address(join, incarnation))
  }

  /** The next free place among the turn's messages: past every row and echoed send holding one. */
  private ordinalFor(
    itemClass: ProviderTimelineItemClass,
    placement: ProviderTimelinePlacement,
    journal: Journal
  ): number | null {
    const turn = placement.turn
    if (!this.deps.scheme.ordinalMessages || itemClass !== 'message' || !turn) {
      return null
    }
    const place = `${providerTimelineKeyPart(placement.thread ?? '')}\u001f${spellProviderTimelineKey(
      this.deps.namespace,
      turn
    )}`
    let ordinal = this.ordinals.get(place) ?? 0
    while (this.taken(this.slot(placement.thread, turn, ordinal), journal)) {
      ordinal += 1
    }
    this.ordinals.set(place, ordinal + 1)
    return ordinal
  }

  private slot(thread: string | null, turn: ProviderTimelineKey, ordinal: number): string {
    return agentJournalItemKey(
      this.deps.scheme.item({
        ...this.address({ family: 'item', key: turn, thread }, 1),
        turn,
        itemClass: 'message',
        messageOrdinal: ordinal
      })
    )
  }

  private taken(itemId: string, journal: Journal): boolean {
    return (
      this.echoes.has(itemId) ||
      (journal !== null &&
        (journal.itemBody(itemId) !== null || journal.canonicalItemId(itemId) !== itemId))
    )
  }
}

function rowOf(
  item: AgentJournalRenderItem | null,
  incarnation: number
): ProviderTimelineRow | null {
  const identity = item ? parseAgentJournalItemKey(item.itemId) : null
  if (!item || !identity) {
    return null
  }
  return {
    identity,
    itemId: item.itemId,
    scope: item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE,
    ...(item.providerItemRef === undefined ? {} : { ref: item.providerItemRef }),
    incarnation
  }
}

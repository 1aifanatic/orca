// Where a new message goes among its (thread, turn)'s messages, for a scheme that keys messages
// by that place. Read back from the journal on a miss, past every place a row or an echoed send
// holds, so a restart continues the sequence the journal already has.

import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session-journal-types'
import { BoundedMap } from '../../../shared/bounded-map'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import {
  providerTimelineKeyPart,
  spellProviderTimelineKey,
  type ProviderTimelineIdentityScheme,
  type ProviderTimelineKey
} from './provider-timeline-identity'

const MAX_TURN_ORDINALS = 256
/** Echoed sends whose slot no row holds yet; a lane records each on its send soon after. */
const MAX_RESERVED_ECHOES = 64

type Journal = StructuredAgentSessionTransitionJournal | null

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export class ProviderTimelineMessagePlaces {
  /** The next ordinal per place. */
  private readonly ordinals = new BoundedMap<string, number>({
    maxEntries: MAX_TURN_ORDINALS,
    maxBytes: MAX_TURN_ORDINALS * 1024,
    sizeOf: (_next, place) => bytes(place) + 8
  })
  private readonly echoes = new BoundedMap<string, true>({
    maxEntries: MAX_RESERVED_ECHOES,
    maxBytes: MAX_RESERVED_ECHOES * 1024,
    sizeOf: (_held, itemId) => bytes(itemId) + 8
  })

  constructor(
    private readonly deps: {
      scheme: ProviderTimelineIdentityScheme
      namespace: () => string
    }
  ) {}

  clear(): void {
    this.ordinals.clear()
    this.echoes.clear()
  }

  /** Holds a place no row takes (an echoed send's). */
  reserve(itemId: string): void {
    this.echoes.set(itemId, true)
  }

  /** The next place in (thread, turn): allocating, so resolvers only. */
  next(thread: string | null, turn: ProviderTimelineKey, journal: Journal): number {
    const place = `${providerTimelineKeyPart(thread ?? '')}\u001f${spellProviderTimelineKey(
      this.deps.namespace(),
      turn
    )}`
    let ordinal = this.ordinals.get(place) ?? this.highWater(thread, turn, journal)
    // Another writer of the same turn may have taken places since this one cached its mark.
    while (this.taken(agentJournalItemKey(this.slot(thread, turn, ordinal)), journal)) {
      ordinal += 1
    }
    this.ordinals.set(place, ordinal + 1)
    return ordinal
  }

  /** One past the highest ordinal the journal holds in the place, like the ordinal counter it
   *  continues: a gap below it (a removed or never-imported row) is never filled. */
  private highWater(thread: string | null, turn: ProviderTimelineKey, journal: Journal): number {
    const read = this.deps.scheme.messageSlot
    const place = read?.(this.slot(thread, turn, 0))?.place
    if (!read || place === undefined || !journal) {
      return 0
    }
    let next = 0
    const consider = (itemId: string | null) => {
      const identity = itemId === null ? null : parseAgentJournalItemKey(itemId)
      const slot = identity ? read(identity) : null
      if (slot?.place === place) {
        next = Math.max(next, slot.ordinal + 1)
      }
    }
    journal.visitItems((itemId) => consider(itemId))
    // An echoed send holds its place through its submission alias, with no row of its own.
    for (const submission of journal.submissions()) {
      consider(submission.providerItemId)
    }
    return next
  }

  private slot(
    thread: string | null,
    turn: ProviderTimelineKey,
    ordinal: number
  ): AgentJournalItemIdentity {
    return this.deps.scheme.item({
      namespace: this.deps.namespace(),
      family: 'item',
      key: turn,
      thread,
      turn,
      itemClass: 'message',
      messageOrdinal: ordinal,
      incarnation: 1
    })
  }

  private taken(itemId: string, journal: Journal): boolean {
    return (
      this.echoes.has(itemId) ||
      (journal !== null &&
        (journal.itemBody(itemId) !== null || journal.canonicalItemId(itemId) !== itemId))
    )
  }
}

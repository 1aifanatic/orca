// What the journal settles in the open chat's outbox, committed: a row, a published card, the
// Stop's answer read through, an entry an older build left, or a host window that closed.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from '../../../../shared/structured-agent-session-outbox-admission'
import {
  applyStructuredAgentSessionOutboxSettlement,
  settleStructuredAgentSessionEntryFromJournal,
  structuredAgentSessionEntryHostWindowEndsAt,
  type StructuredAgentSessionJournalReading,
  type StructuredAgentSessionOutboxSettlement,
  type StructuredAgentSessionSettledOutbox
} from '../../../../shared/structured-agent-session-outbox-settlement'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  sayStructuredAgentSessionSettlement,
  structuredAgentSessionSettlementEndingNow
} from './structured-agent-session-outbox-dispatch'
import { endStructuredAgentSessionEntry } from './structured-agent-session-entry-endings'
import { setStructuredAgentSessionChatLine } from './structured-agent-session-returned-send'
import { handBackStructuredAgentSessionEntry } from './structured-agent-session-outbox-returning'

/** Settles every entry the reading settles and commits the outbox, which it returns. */
export function settleStructuredAgentSessionOutboxFromJournal(
  sessionId: string,
  reading: StructuredAgentSessionJournalReading
): StructuredAgentSessionOutboxEntry[] {
  const current = getStructuredAgentSessionOutbox(sessionId)
  let entries = current
  const returned: NonNullable<StructuredAgentSessionSettledOutbox['returned']>[] = []
  const settled: {
    entry: StructuredAgentSessionOutboxEntry
    settlement: StructuredAgentSessionOutboxSettlement
  }[] = []
  for (const entry of current) {
    const settlement = settleStructuredAgentSessionEntryFromJournal(entry, reading)
    if (settlement) {
      const next = applyStructuredAgentSessionOutboxSettlement(
        entries,
        entry.clientMessageId,
        settlement
      )
      entries = next.entries
      settled.push({ entry, settlement })
      if (next.returned) {
        returned.push(next.returned)
      }
    }
  }
  if (entries === current) {
    return entries
  }
  for (const { entry, settlement } of settled) {
    const ending = structuredAgentSessionSettlementEndingNow(settlement)
    if (ending) {
      endStructuredAgentSessionEntry(entry, ending)
    }
  }
  // A returned message is committed marked returning before its text goes to the draft, and
  // leaves once the draft is saved (structured-agent-session-outbox-returning).
  commitStructuredAgentSessionOutbox(sessionId, entries)
  for (const back of returned) {
    handBackStructuredAgentSessionEntry(back.entry)
    if (back.words) {
      setStructuredAgentSessionChatLine(sessionId, back.words)
    }
  }
  for (const { entry, settlement } of settled) {
    sayStructuredAgentSessionSettlement(sessionId, entry.clientMessageId, settlement)
  }
  return entries
}

/** When the soonest host window still open closes among entries only an owed answer settles, or
 *  null. One already closed waits for the journal to load, which re-runs the settlement anyway. */
export function nextStructuredAgentSessionHostWindowEnd(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  now: number
): number | null {
  let soonest: number | null = null
  for (const entry of entries) {
    const endsAt = structuredAgentSessionEntryAwaitsSettlement(entry)
      ? structuredAgentSessionEntryHostWindowEndsAt(entry)
      : null
    if (endsAt !== null && endsAt >= now && (soonest === null || endsAt < soonest)) {
      soonest = endsAt
    }
  }
  return soonest
}

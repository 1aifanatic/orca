// What the journal settles in the open chat's outbox, committed: a row, a published card, the
// Stop's answer read through, an entry an older build left, or a host window that closed.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from '../../../../shared/structured-agent-session-outbox-admission'
import {
  applyStructuredAgentSessionSendSettlement,
  settleStructuredAgentSessionEntryFromJournal,
  structuredAgentSessionEntryHostWindowEndsAt,
  type StructuredAgentSessionJournalReading,
  type StructuredAgentSessionSendSettlement,
  type StructuredAgentSessionSettledOutbox
} from '../../../../shared/structured-agent-session-send-settlement'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  sayStructuredAgentSessionSettlement,
  structuredAgentSessionSettlementEnding
} from './structured-agent-session-outbox-dispatch'
import { endStructuredAgentSessionEntry } from './structured-agent-session-entry-endings'
import {
  returnStructuredAgentSessionMessage,
  setStructuredAgentSessionChatLine
} from './structured-agent-session-returned-send'

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
    settlement: StructuredAgentSessionSendSettlement
  }[] = []
  for (const entry of current) {
    const settlement = settleStructuredAgentSessionEntryFromJournal(entry, reading)
    if (settlement) {
      const next = applyStructuredAgentSessionSendSettlement(
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
  // Each returned message goes to the draft before its entry ends (clearing the notes it carried)
  // and before the outbox that drops it is saved.
  for (const back of returned) {
    returnStructuredAgentSessionMessage(back.entry)
    if (back.words) {
      setStructuredAgentSessionChatLine(sessionId, back.words)
    }
  }
  for (const { entry, settlement } of settled) {
    const ending = structuredAgentSessionSettlementEnding(settlement)
    if (ending) {
      endStructuredAgentSessionEntry(entry, ending)
    }
  }
  commitStructuredAgentSessionOutbox(sessionId, entries)
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

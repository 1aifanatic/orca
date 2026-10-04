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
import { sayStructuredAgentSessionSettlement } from './structured-agent-session-outbox-dispatch'
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
  const settled: { clientMessageId: string; settlement: StructuredAgentSessionSendSettlement }[] =
    []
  for (const entry of current) {
    const settlement = settleStructuredAgentSessionEntryFromJournal(entry, reading)
    if (settlement) {
      const next = applyStructuredAgentSessionSendSettlement(
        entries,
        entry.clientMessageId,
        settlement
      )
      entries = next.entries
      settled.push({ clientMessageId: entry.clientMessageId, settlement })
      if (next.returned) {
        returned.push(next.returned)
      }
    }
  }
  if (entries === current) {
    return entries
  }
  // Each returned message goes to the draft before the outbox that drops it is saved.
  for (const back of returned) {
    returnStructuredAgentSessionMessage(back.entry)
    if (back.words) {
      setStructuredAgentSessionChatLine(sessionId, back.words)
    }
  }
  commitStructuredAgentSessionOutbox(sessionId, entries)
  for (const { clientMessageId, settlement } of settled) {
    sayStructuredAgentSessionSettlement(sessionId, clientMessageId, settlement)
  }
  return entries
}

/** When the soonest host window closes among entries only an owed answer settles, or null. */
export function nextStructuredAgentSessionHostWindowEnd(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): number | null {
  let soonest: number | null = null
  for (const entry of entries) {
    const endsAt = structuredAgentSessionEntryAwaitsSettlement(entry)
      ? structuredAgentSessionEntryHostWindowEndsAt(entry)
      : null
    if (endsAt !== null && (soonest === null || endsAt < soonest)) {
      soonest = endsAt
    }
  }
  return soonest
}

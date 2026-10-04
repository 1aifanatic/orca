// One admission budget for everything the assembler holds open: running items, pending requests
// and open text streams. It is derived, not booked: the open set is the forecast's obligations
// plus the open streams, one entry per item (an item and its stream share its join reference) and
// one per request key whatever its incarnation. Before refusing, the set is re-derived from the
// journal, so an answer a client gave or a row another writer settled frees its room. Past the
// budget an event is refused as `failed`, which ends the session the way a failed journal write
// does, and the journal-derived dead-generation settlement closes whatever it left open.

import { requiresTerminalSettlement } from '../agent-session-journal/journal-terminal-settlement'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineState } from './provider-timeline-state'

export const MAX_PROVIDER_TIMELINE_OPEN_ENTRIES = 128
export const MAX_PROVIDER_TIMELINE_OPEN_BYTES = 1024 * 1024

export const PROVIDER_TIMELINE_OVER_BUDGET: StructuredAgentSessionSinkAdmission = {
  accepted: false,
  reason: 'failed'
}

export type ProviderTimelineHold = { key: string; bytes: number }

export function providerTimelineBudgetAdmits(input: {
  hold: ProviderTimelineHold
  forecast: ProviderTimelineState
  ledger: ProviderTimelineState
  streams: readonly ProviderTimelineHold[]
  journal: StructuredAgentSessionTransitionJournal | null
}): boolean {
  if (fits(input)) {
    return true
  }
  // The fold is never behind the ledger, so what it shows settled is settled in both.
  for (const state of [input.forecast, input.ledger]) {
    for (const [key, obligation] of state.obligations) {
      const body = obligation.itemId ? input.journal?.itemBody(obligation.itemId) : null
      if (body && !requiresTerminalSettlement(body)) {
        state.obligations.delete(key)
      }
    }
  }
  return fits(input)
}

function fits(input: {
  hold: ProviderTimelineHold
  forecast: ProviderTimelineState
  streams: readonly ProviderTimelineHold[]
}): boolean {
  const open = new Map<string, number>()
  for (const [key, obligation] of input.forecast.obligations) {
    open.set(key, obligation.bytes)
  }
  for (const stream of input.streams) {
    open.set(stream.key, Math.max(open.get(stream.key) ?? 0, stream.bytes))
  }
  open.set(input.hold.key, Math.max(open.get(input.hold.key) ?? 0, input.hold.bytes))
  let bytes = 0
  for (const each of open.values()) {
    bytes += each
  }
  return (
    open.size <= MAX_PROVIDER_TIMELINE_OPEN_ENTRIES && bytes <= MAX_PROVIDER_TIMELINE_OPEN_BYTES
  )
}

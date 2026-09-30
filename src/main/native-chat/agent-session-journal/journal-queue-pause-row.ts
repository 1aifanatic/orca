// The row a person's Stop or Resume appends: a tombstone of an id no item ever takes, carrying
// the mark (`journal-row-schema.ts` says why not a row kind of its own).

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import { journalRowBase } from './journal-row-builders'
import type { JournalQueuePauseMark, JournalTombstoneRow } from './journal-row-schema'

/** The one id the queue's Stop and Resume rows name; no item ever takes it. */
const JOURNAL_QUEUE_PAUSE_ITEM_ID = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: 'queue-pause'
})

export function buildJournalQueuePauseRow(input: {
  state: JournalReducerState
  mark: JournalQueuePauseMark
  seq: number
  fence: number
  ts: number
}): JournalTombstoneRow {
  return {
    kind: 'tombstone',
    itemId: JOURNAL_QUEUE_PAUSE_ITEM_ID,
    revision: 1,
    queuePause: input.mark,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts)
  }
}

export function journalQueuePauseRowBuilder(
  state: () => JournalReducerState,
  mark: JournalQueuePauseMark,
  fence: number
): (seq: number, ts: number) => JournalTombstoneRow {
  return (seq, ts) => buildJournalQueuePauseRow({ state: state(), mark, seq, fence, ts })
}

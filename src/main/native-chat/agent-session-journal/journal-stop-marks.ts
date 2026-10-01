// What the journal answers about its Stops beyond the queue's pause: the latest Stop event and
// whether a refusal answered it, which the turn-end rule reads (`journal-stop-turn-end.ts`).

import type { JournalReducerState } from './journal-reducer'
import type { JournalRow, JournalStopRefusal } from './journal-row-schema'
import { journalStopRefusalRowBuilder } from './journal-stop-and-resume-rows'
import { journalLatestStop, type JournalLatestStop } from './journal-stop-turn-end'

export class JournalStopMarks {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
    }
  ) {}

  latest(): JournalLatestStop | null {
    return journalLatestStop(this.deps.state())
  }

  /** The provider refused a Stop's interrupt and its turn runs on (`JournalStopRefusal`). */
  async appendRefusal(refusal: JournalStopRefusal, fence: number): Promise<void> {
    await this.deps.enqueue(journalStopRefusalRowBuilder(this.deps.state, refusal, fence))
  }
}

// What the journal answers about its Stops beyond the queue's pause: the latest Stop event, which
// the turn-end rule reads (`journal-stop-turn-end.ts`), and whether a person's still decides.

import type { JournalReducerState } from './journal-reducer'
import { personStopInForce, type JournalLatestStop } from './journal-stop-turn-end'

export class JournalStopMarks {
  constructor(private readonly deps: { state: () => JournalReducerState }) {}

  latest(): JournalLatestStop | null {
    return this.deps.state().queuePauseMarks.latestStop
  }

  /** `personStopInForce`: a person's Stop already decides what runs now. */
  personStopInForce(turnId: string | null): boolean {
    return personStopInForce(this.deps.state(), turnId)
  }
}

// What the journal answers about its Stops beyond the queue's pause: the latest Stop event, which
// the turn-end rule reads (`journal-stop-turn-end.ts`), whether a person's covers or still decides
// a turn, and whether a Stop still counts by its answers (`journal-stop-answers.ts`).

import type { JournalReducerState } from './journal-reducer'
import type { JournalStopEvent } from './journal-row-schema'
import { journalStopStillCounts } from './journal-stop-answers'
import {
  latestAcceptedSendUnopened,
  personStopCoversTurn,
  personStopDecidesTurn,
  type JournalLatestStop
} from './journal-stop-turn-end'

export class JournalStopMarks {
  constructor(private readonly deps: { state: () => JournalReducerState }) {}

  latest(): JournalLatestStop | null {
    return this.deps.state().queuePauseMarks.latestStop
  }

  /** `latestAcceptedSendUnopened`: the latest accepted send's turn row may still be on its way. */
  latestAcceptedSendUnopened(): boolean {
    return latestAcceptedSendUnopened(this.deps.state())
  }

  /** `personStopCoversTurn`: a person's Stop is in force for turn `turnId`, whatever it answered. */
  personStopCovers(turnId: string | null): boolean {
    return personStopCoversTurn(this.deps.state(), turnId)
  }

  /** `personStopDecidesTurn`: a person's Stop decides how turn `turnId` ends. */
  personStopDecides(turnId: string | null, endedAt?: number, openedBy?: string): boolean {
    return personStopDecidesTurn(this.deps.state(), turnId, endedAt, openedBy)
  }

  /** `journalStopStillCounts`: the Stop that wrote `event` has no answer yet, or one says it took. */
  stillCounts(event: Pick<JournalStopEvent, 'id'>): boolean {
    return journalStopStillCounts(this.deps.state(), event)
  }
}

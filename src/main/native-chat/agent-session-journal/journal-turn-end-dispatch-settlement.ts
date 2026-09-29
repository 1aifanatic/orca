// A provider ending the turn it was running ends what every send handed to it still owed.
//
// A handed-over send the provider has neither answered nor refused counts as work, so the chat
// reads working and the idle sweep keeps the agent. Once the provider ends its turn, nothing is left
// that owes that send an answer: it settles as recovered `unknown` — doubt, drawn as sent — and a
// late acceptance or refusal from the provider still replaces it. The sends are read inside the
// terminal row's serialized write, so one handed over after that row is never taken for this turn's.

import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { activeStructuredAgentSessionTurnIdBySequence } from '../../../shared/structured-agent-session-live-turn'
import { structuredAgentSessionSubmissionSettlement } from '../../../shared/structured-agent-session-submission-settlement'
import { DISPATCH_DOUBT_TURN_SETTLED } from './journal-dispatch-doubt-reasons'
import { markJournalPendingSubmissionsUnknown } from './journal-pending-submission-recovery'
import type { JournalReducerState } from './journal-reducer'
import type { AgentSessionJournal } from './journal-store'

export type JournalTurnEndDispatchSettlement = {
  /** Runs inside the write's serialized build, before its row is applied. */
  capture: () => void
  /** Settles what `capture` found once the write has landed; never fails the write. */
  after: <T>(write: Promise<T>) => Promise<T>
}

const NOTHING_TO_SETTLE: JournalTurnEndDispatchSettlement = {
  capture: () => undefined,
  after: (write) => write
}

export function journalTurnEndDispatchSettlement(
  journal: AgentSessionJournal,
  state: () => JournalReducerState,
  bodies: readonly AgentJournalItemBody[],
  /** A host settlement writes `recovered` rows and settles its own sends. */
  options: { fence: number; recovered?: true }
): JournalTurnEndDispatchSettlement {
  const endedTurnIds = options.recovered
    ? []
    : bodies.flatMap((body) => {
        const turn = readAgentJournalTurn(body)
        return turn && turn.state !== 'running' ? [turn.turnId] : []
      })
  if (endedTurnIds.length === 0) {
    return NOTHING_TO_SETTLE
  }
  const owed = new Set<string>()
  return {
    capture: () => {
      const { items, submissions } = state()
      const active = activeStructuredAgentSessionTurnIdBySequence(items.values())
      // Only the turn running now: a late revision of an earlier turn ends nothing handed over since.
      if (active === null || !endedTurnIds.includes(active)) {
        return
      }
      for (const submission of submissions.values()) {
        if (
          submission.fence === options.fence &&
          !isQueuedAgentJournalSubmission(submission) &&
          structuredAgentSessionSubmissionSettlement(submission) === 'open'
        ) {
          owed.add(submission.clientMessageId)
        }
      }
    },
    after: (write) =>
      write.then(async (result) => {
        if (owed.size > 0) {
          // The next exit (a Stop, the child's end, the next open) settles what this could not.
          await markJournalPendingSubmissionsUnknown(
            journal,
            options.fence,
            DISPATCH_DOUBT_TURN_SETTLED,
            (submission) => owed.has(submission.clientMessageId)
          ).catch((error: unknown) => {
            console.warn('[agent-session] settling sends at a turn end failed:', error)
          })
        }
        return result
      })
  }
}

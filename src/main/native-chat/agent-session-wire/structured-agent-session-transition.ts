// One provider event's journal writes, admitted as a single sink operation.
//
// A producer that keeps state about what it wrote must change that state only for writes the sink
// took; when an event needs several rows, a refusal of the third after the first two were taken
// would leave the producer and the journal disagreeing. A transition is admitted whole or not at
// all. At execution its steps are issued in the same tick, so they sit together in the journal's
// write queue, and each step resolves against the fold with every earlier write landed — the
// steps before it included — so what a step writes is decided by the journal, not by memory.
// Admitted whole, executed as a prefix: once a step fails, the steps after it write nothing, the
// steps before it stay written, and the sink fails, so nothing more is admitted after it.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionSinkAdmission
} from './structured-agent-session-event-sink'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

/** What a transition step reads: rows by key, every row, and the turns they joined. */
export type StructuredAgentSessionTransitionJournal = Pick<
  AgentSessionJournal,
  'epoch' | 'visitItems' | 'itemBody' | 'item' | 'visitItemsWithLinkage'
>

export type StructuredAgentSessionTransitionStep =
  | {
      kind: 'item'
      /** Bounds what `resolve` may write; a larger write fails the sink. */
      reservedBytes: number
      /** The row and its whole body; null writes nothing. */
      resolve: (journal: StructuredAgentSessionTransitionJournal) => {
        identity: AgentJournalItemIdentity
        body: AgentJournalItemBody
      } | null
      options: StructuredAgentSessionItemAppendOptions
    }
  | {
      kind: 'settlement'
      /** Unique per settlement: the journal applies one id once. */
      settlementId: string
      /** Paces the queue only; the mutations are the journal's to choose. */
      reservedBytes: number
      /** Read at execution; none writes nothing. */
      resolve: (
        journal: StructuredAgentSessionTransitionJournal
      ) => readonly JournalLifecycleMutationInput[]
    }

export type StructuredAgentSessionTransition = {
  steps: readonly StructuredAgentSessionTransitionStep[]
  /** Rides the sink's lifecycle budget: it ends or settles something. */
  lifecycle: boolean
  /** Announce the writes once they land, when any step wrote. */
  publish: boolean
}

const STEP_OVERFLOW = 'structured agent-session transition step exceeded its reserved size'

/** The sink members a transition writer uses. */
export type StructuredAgentSessionTransitionSink = {
  /** Queues one event's writes as a single admitted operation. */
  tryAppendTransition?(
    transition: StructuredAgentSessionTransition
  ): StructuredAgentSessionSinkAdmission
  /** The bound journal's rows as they stand now; null until bound. */
  journalItems?(): StructuredAgentSessionTransitionJournal | null
}

export function createStructuredAgentSessionTransitionMembers(
  queue: StructuredAgentSessionSinkQueue
): Required<StructuredAgentSessionTransitionSink> {
  return { tryAppendTransition: transitionAppend(queue), journalItems: queue.journalItems }
}

function transitionAppend(
  queue: StructuredAgentSessionSinkQueue
): (transition: StructuredAgentSessionTransition) => StructuredAgentSessionSinkAdmission {
  return (transition) =>
    queue.submit({
      bytes:
        transition.steps.reduce((total, step) => total + step.reservedBytes, 0) +
        (transition.publish ? 1 : 0),
      lifecycle: transition.lifecycle,
      run: async (bound) => {
        const { journal, fence } = bound
        const gate = createStepGate(journal)
        // Issued in one tick, so no write submitted after this transition lands between its steps.
        const writes = transition.steps.map((step, index) =>
          step.kind === 'item'
            ? journal
                .appendResolvedItem(
                  () => {
                    const resolved = gate.open(index) ? step.resolve(journal) : null
                    if (!resolved) {
                      gate.wroteNothing()
                      return null
                    }
                    if (
                      estimateStructuredAgentSessionItemBytes(resolved.identity, resolved.body) >
                      step.reservedBytes
                    ) {
                      throw new Error(STEP_OVERFLOW)
                    }
                    return resolved
                  },
                  structuredAgentSessionJournalAppendOptions(fence, step.options)
                )
                .then((landed) => landed !== null)
            : journal
                .appendResolvedLifecycleBatch({
                  settlementId: step.settlementId,
                  resolve: () => (gate.open(index) ? step.resolve(journal) : []),
                  fence
                })
                .then((landed) => landed !== null)
        )
        // Every step, the ones a failure turned into no-ops included, has run before this settles.
        const outcomes = await Promise.allSettled(writes)
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
        )
        if (failure) {
          throw failure.reason
        }
        if (
          transition.publish &&
          outcomes.some((outcome) => outcome.status === 'fulfilled' && outcome.value)
        ) {
          bound.publish()
        }
      }
    })
}

/** Lets a step write only when every step before it landed. Steps run in queue order, so each
 *  step's write learns synchronously, from the journal's count of completed writes, whether the
 *  write handed over just ahead of it landed; a promise would say so only after it ran. */
function createStepGate(journal: Pick<AgentSessionJournal, 'completedWrites'>): {
  /** First thing step `index` does at its turn; false once an earlier step failed. */
  open: (index: number) => boolean
  /** The step writes nothing, so whether its write completes says nothing about a failure. */
  wroteNothing: () => void
} {
  let failed = false
  let reached = 0
  let handedAt: number | null = null
  return {
    open: (index) => {
      // A step that never reached its resolve failed before it: a refused import, a read-only journal.
      if (reached !== index || (handedAt !== null && journal.completedWrites === handedAt)) {
        failed = true
      }
      reached = index + 1
      handedAt = failed ? null : journal.completedWrites
      return !failed
    },
    wroteNothing: () => {
      handedAt = null
    }
  }
}

import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { partitionJournalLifecycleMutations } from './journal-lifecycle-batch-partition'
import { journalLifecycleBatchRowBuilder } from './journal-row-builders'
import type {
  JournalLifecycleBatchInput,
  JournalResolvedLifecycleBatchInput
} from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import type { JournalRowWriter } from './journal-row-writer'
import { journalQueuedRejectionRowBuilders } from './journal-pending-submission-recovery'

const SETTLEMENT_ALREADY_APPLIED = new Error('journal_settlement_already_applied')

export class JournalLifecycleBatchAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      cursor: () => AgentJournalCursor
      enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
      enqueueEach: JournalRowWriter['enqueueEach']
      enqueueRows: JournalRowWriter['enqueueRows']
    }
  ) {}

  append(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    const { rejectsQueued } = input
    if (rejectsQueued) {
      // Planned on the lane: the sends queued then, and this batch unless it already landed. With
      // none left (a Stop withdrew them first) it failed no one, so nothing is written.
      return this.deps
        .enqueueRows(() => {
          const rejections = journalQueuedRejectionRowBuilders(
            this.deps.state,
            input.fence,
            rejectsQueued
          )
          return rejections.length === 0 || this.wasApplied(input.settlementId)
            ? rejections
            : [
                ...rejections,
                journalLifecycleBatchRowBuilder(
                  this.deps.state,
                  input.settlementId,
                  input.mutations,
                  input
                )
              ]
        })
        .then(() => this.deps.cursor())
    }
    if (this.wasApplied(input.settlementId)) {
      return Promise.resolve(this.deps.cursor())
    }
    const build = journalLifecycleBatchRowBuilder(
      this.deps.state,
      input.settlementId,
      input.mutations,
      input
    )
    return this.deps
      .enqueue((seq, ts) => {
        if (this.wasApplied(input.settlementId)) {
          throw SETTLEMENT_ALREADY_APPLIED
        }
        return build(seq, ts)
      })
      .then((row) => ({ epoch: row.epoch, sequence: row.seq }))
      .catch((error: unknown) => {
        if (error === SETTLEMENT_ALREADY_APPLIED) {
          return this.deps.cursor()
        }
        throw error
      })
  }

  /** Chooses the mutations at its turn in the queue; one too large for a row becomes consecutive
   *  rows that nothing else lands between, in the order resolved. */
  appendResolved(input: JournalResolvedLifecycleBatchInput): Promise<AgentJournalCursor | null> {
    return this.deps
      .enqueueEach(() =>
        partitionJournalLifecycleMutations(input.settlementId, input.resolve())
          .filter((chunk) => !this.wasApplied(chunk.settlementId))
          .map((chunk) =>
            journalLifecycleBatchRowBuilder(
              this.deps.state,
              chunk.settlementId,
              chunk.mutations,
              input
            )
          )
      )
      .then((rows) => {
        const last = rows.at(-1)
        return last ? { epoch: last.epoch, sequence: last.seq } : null
      })
  }

  private wasApplied(settlementId: string): boolean {
    return this.deps.state().appliedSettlementIds.has(settlementId)
  }
}

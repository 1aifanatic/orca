import { isDeepStrictEqual } from 'node:util'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import {
  journalLifecycleMutationFitsOneBatch,
  partitionJournalLifecycleMutations
} from './journal-lifecycle-batch-partition'
import {
  journalDispatchRowBuilder,
  journalItemRowBuilder,
  journalLifecycleBatchRowBuilder,
  journalTombstoneRowBuilder,
  journalLifecycleMutationItemId,
  type JournalLifecycleMutationInput
} from './journal-row-builders'
import type {
  JournalLifecycleBatchInput,
  JournalResolvedLifecycleBatchInput
} from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import { journalQueuedRejectionRowBuilders } from './journal-pending-submission-recovery'

export class JournalLifecycleBatchAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      cursor: () => AgentJournalCursor
      enqueueRows: (
        plan: () => readonly ((seq: number, ts: number) => JournalRow)[]
      ) => Promise<JournalRow[]>
    }
  ) {}

  append(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.deps
      .enqueueRows(() => {
        if (input.rejectsQueued) {
          const rejections = journalQueuedRejectionRowBuilders(
            this.deps.state,
            input.fence,
            input.rejectsQueued
          )
          if (rejections.length > 0 && input.mutations.length === 0) {
            throw new Error('journal_lifecycle_batch_mutation_bound_exceeded')
          }
          return rejections.length === 0
            ? []
            : [...rejections, ...this.planMutations(input, input.mutations)]
        }
        if (this.wasApplied(input.settlementId)) {
          return []
        }
        return [
          ...(input.dispatches ?? []).map((dispatch) =>
            journalDispatchRowBuilder(this.deps.state, dispatch)
          ),
          ...this.planMutations(input, input.mutations)
        ]
      })
      .then((rows) => {
        const last = rows.at(-1)
        return last ? { epoch: last.epoch, sequence: last.seq } : this.deps.cursor()
      })
  }

  /** The rows a resolved settlement writes, planned at its own turn in the queue: its mutations,
   *  chosen then, in as many consecutive rows as they need, minus any already applied. */
  planResolved(
    input: JournalResolvedLifecycleBatchInput
  ): ((seq: number, ts: number) => JournalRow)[] {
    const mutations = input.resolve()
    // Every chunk is built before any commits, so a second chunk naming the same item would
    // reuse the first chunk's revision.
    this.assertDistinctItems(mutations)
    return this.planMutations(input, mutations)
  }

  private planMutations(
    input: Pick<JournalLifecycleBatchInput, 'settlementId' | 'fence' | 'recovered'>,
    mutations: readonly JournalLifecycleMutationInput[]
  ): ((seq: number, ts: number) => JournalRow)[] {
    if (this.wasApplied(input.settlementId)) {
      return []
    }
    const current = this.deps.state()
    // Unadvanceable saved revisions stay untouched without vetoing the other items.
    const advanceable = mutations.filter((mutation) => {
      const itemId = journalLifecycleMutationItemId(mutation)
      const resolved = current.aliases.get(itemId) ?? itemId
      return [
        current.items.get(resolved)?.revision ?? 0,
        current.tombstones.get(resolved) ?? 0
      ].every((revision) => Number.isSafeInteger(revision) && revision < Number.MAX_SAFE_INTEGER)
    })
    const options = { ...input, epoch: current.epoch }
    let namedSettlement = false
    return partitionJournalLifecycleMutations(input.settlementId, advanceable, options).flatMap(
      (chunk): ((seq: number, ts: number) => JournalRow)[] => {
        const [only] = chunk.mutations
        if (
          chunk.mutations.length === 1 &&
          only &&
          !journalLifecycleMutationFitsOneBatch(chunk.settlementId, only, options)
        ) {
          const itemId = journalLifecycleMutationItemId(only)
          const resolved = current.aliases.get(itemId) ?? itemId
          if (only.kind === 'tombstone') {
            const build = journalTombstoneRowBuilder(this.deps.state, itemId, input.fence)
            return current.tombstones.has(resolved)
              ? []
              : [
                  (seq, ts) => ({
                    ...build(seq, ts),
                    ...(input.recovered ? { recovered: true as const } : {})
                  })
                ]
          }
          const existing = current.items.get(resolved)
          // An all-oversized settlement has no batch receipt; its terminal bodies are its receipt.
          return existing &&
            isDeepStrictEqual(existing.body, only.body) &&
            (only.linkage === undefined ||
              isDeepStrictEqual(
                agentJournalLinkageFields(existing),
                agentJournalLinkageFields(only.linkage)
              ))
            ? []
            : [
                journalItemRowBuilder(this.deps.state, itemId, only.body, {
                  ...only.linkage,
                  turnScope: only.turnScope,
                  fence: input.fence,
                  recovered: input.recovered
                })
              ]
        }
        // One bounded row remembers the generation even when the re-derived plan has fewer items.
        const id = namedSettlement ? chunk.settlementId : input.settlementId
        namedSettlement = true
        return this.wasApplied(id)
          ? []
          : [journalLifecycleBatchRowBuilder(this.deps.state, id, chunk.mutations, input)]
      }
    )
  }

  private assertDistinctItems(mutations: readonly JournalLifecycleMutationInput[]): void {
    const { aliases } = this.deps.state()
    const seen = new Set<string>()
    for (const mutation of mutations) {
      const itemId = journalLifecycleMutationItemId(mutation)
      const resolved = aliases.get(itemId) ?? itemId
      if (seen.has(resolved)) {
        throw new Error('journal_resolved_lifecycle_batch_names_item_twice')
      }
      seen.add(resolved)
    }
  }

  private wasApplied(settlementId: string): boolean {
    return this.deps.state().appliedSettlementIds.has(settlementId)
  }
}

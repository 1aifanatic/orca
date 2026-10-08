import { describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { createJournalReducerState } from './journal-reducer'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'

function item(itemId: string, text = 'saved'): JournalLifecycleMutationInput {
  return {
    kind: 'item',
    itemId,
    body: { kind: 'status', text },
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  }
}

describe.each(['direct', 'resolved'] as const)('%s lifecycle planning', (mode) => {
  it.each(['chunks', 'oversized', 'alias'] as const)(
    'rejects repeated items across %s before any row is written',
    async (repeatedAs) => {
      const state = createJournalReducerState('session', 'epoch')
      state.aliases.set('alias', 'saved')
      const rows: JournalRow[] = []
      const appender = new JournalLifecycleBatchAppender({
        state: () => state,
        cursor: () => ({ epoch: state.epoch, sequence: state.lastSequence }),
        enqueueRows: async (plan) => {
          const built = plan().map((build, index) => build(index + 1, 1_000))
          rows.push(...built)
          return built
        }
      })
      const mutations = [
        item('saved', repeatedAs === 'oversized' ? 'x'.repeat(1_500_001) : 'first'),
        ...Array.from({ length: 200 }, (_, index) => item(`filler-${index}`)),
        repeatedAs === 'alias'
          ? { kind: 'tombstone' as const, itemId: 'alias' }
          : item('saved', 'second')
      ]
      const input = { settlementId: 'settlement', fence: 8 }
      if (mode === 'direct') {
        await expect(appender.append({ ...input, mutations })).rejects.toThrow(
          'journal_resolved_lifecycle_batch_names_item_twice'
        )
      } else {
        expect(() => appender.planResolved({ ...input, resolve: () => mutations })).toThrow(
          'journal_resolved_lifecycle_batch_names_item_twice'
        )
      }
      expect(rows).toEqual([])
      expect(state.items.size).toBe(0)
      expect(state.lastSequence).toBe(0)
    }
  )
})

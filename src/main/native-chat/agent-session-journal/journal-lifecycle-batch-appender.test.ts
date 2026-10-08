import { describe, expect, it } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import type { JournalLifecycleMutationInput } from './journal-row-builders'
import { parseJournalRow, type JournalRow } from './journal-row-schema'

describe.each(['direct', 'resolved'] as const)('%s lifecycle planning', (mode) => {
  it.each([
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    -Number.MAX_SAFE_INTEGER - 1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ])(
    'omits unadvanceable item and tombstone revisions %s without losing healthy work',
    async (revision) => {
      const state = createJournalReducerState('session', 'epoch')
      applyJournalRow(state, {
        v: 3,
        kind: 'item',
        epoch: state.epoch,
        seq: 1,
        ts: 900,
        fence: 7,
        itemId: 'saved',
        revision,
        body: { kind: 'status', text: 'saved' }
      })
      state.aliases.set('alias', 'saved')
      state.tombstones.set('removed', revision)
      const before = structuredClone(state.items.get('saved'))
      const rows: JournalRow[] = []
      const appender = new JournalLifecycleBatchAppender({
        state: () => state,
        cursor: () => ({ epoch: state.epoch, sequence: 1 }),
        enqueueRows: async (plan) => {
          const built = plan().map((build, index) => build(index + 2, 1_000))
          rows.push(...built)
          return built
        }
      })
      const unadvanceable: JournalLifecycleMutationInput[] = [
        {
          kind: 'item',
          itemId: 'alias',
          body: { kind: 'status', text: 'changed' },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        { kind: 'tombstone', itemId: 'removed' }
      ]
      const mutations: JournalLifecycleMutationInput[] = [
        ...unadvanceable,
        {
          kind: 'item',
          itemId: 'healthy',
          body: { kind: 'status', text: 'settled' },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ]
      const input = { settlementId: 'settlement', fence: 8 }
      if (mode === 'direct') {
        await appender.append({ ...input, mutations })
      } else {
        rows.push(
          ...appender
            .planResolved({ ...input, resolve: () => mutations })
            .map((build, index) => build(index + 2, 1_000))
        )
      }
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        kind: 'lifecycle-batch',
        mutations: [{ kind: 'item', itemId: 'healthy', revision: 1 }]
      })
      for (const row of rows) {
        expect(parseJournalRow(JSON.stringify(row), 'write')).toMatchObject({ ok: true })
      }
      expect(state.items.get('saved')).toEqual(before)
      expect(state.tombstones.get('removed')).toBe(revision)
      if (mode === 'direct') {
        await appender.append({ ...input, mutations: unadvanceable })
        expect(rows).toHaveLength(1)
      } else {
        expect(appender.planResolved({ ...input, resolve: () => unadvanceable })).toEqual([])
      }
    }
  )
})

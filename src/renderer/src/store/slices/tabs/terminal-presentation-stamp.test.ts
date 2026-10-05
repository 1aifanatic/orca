import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { AppState } from '../../types'
import {
  installTerminalPresentationStampTracking,
  noteTerminalPresentationIntent,
  noteTerminalPresentationLaunch,
  readTerminalPresentationStamp,
  readTerminalPresentationToken,
  resetTerminalPresentationStampsForTest
} from './terminal-presentation-stamp'

const WT = 'wt'

type Slice = Pick<AppState, 'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'>

/** Minimal rows: the tracker reads only ids, view, owner, hint and bindings. */
function asSlice(value: unknown): Partial<Slice> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test rows carry every field the tracker reads.
  return value as Partial<Slice>
}

function makeStore() {
  const store = createStore<Slice>(() => ({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }))
  installTerminalPresentationStampTracking(store)
  const put = (patch: Partial<Slice>): void => store.setState(patch)
  const row = (launchAgent?: 'claude' | 'codex') => ({
    tabsByWorktree: {
      [WT]: [{ id: 't1', ptyId: 'p1', ...(launchAgent ? { launchAgent } : {}) }]
    }
  })
  return { store, put, row }
}

afterEach(() => {
  resetTerminalPresentationStampsForTest()
  vi.useRealTimers()
})

describe('terminal presentation stamp', () => {
  it('advances on every presentation change and keeps its token stable otherwise', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000 })
    const { put, row } = makeStore()
    put(asSlice(row('codex')))
    const first = readTerminalPresentationToken('t1')
    put(
      asSlice({
        tabsByWorktree: { [WT]: [{ id: 't1', ptyId: 'p1', launchAgent: 'codex', title: 'x' }] }
      })
    )
    expect(readTerminalPresentationToken('t1')).toBe(first)
    vi.setSystemTime(2_000)
    put(
      asSlice({
        unifiedTabsByWorktree: {
          [WT]: [{ id: 'u1', entityId: 't1', contentType: 'terminal', viewMode: 'chat' }]
        }
      })
    )
    expect(readTerminalPresentationToken('t1')).not.toBe(first)
    expect(readTerminalPresentationStamp('t1').changedAtMs).toBe(2_000)
  })

  it('orders a same-value intent after earlier exits', () => {
    makeStore()
    const before = readTerminalPresentationStamp('t1').revision
    noteTerminalPresentationIntent('t1')
    expect(readTerminalPresentationStamp('t1').revision).toBe(before + 1)
    expect(readTerminalPresentationStamp('t1').launchRevision).toBe(0)
  })

  it('advances the launch revision when the hint changes or a relaunch is noted', () => {
    const { put, row } = makeStore()
    put(asSlice(row('claude')))
    put(asSlice(row()))
    expect(readTerminalPresentationStamp('t1').launchRevision).toBe(1)
    noteTerminalPresentationLaunch('t1')
    expect(readTerminalPresentationStamp('t1').launchRevision).toBe(2)
  })
})

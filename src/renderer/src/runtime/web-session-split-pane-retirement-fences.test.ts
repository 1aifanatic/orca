import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { collectLeafIds } from '../components/terminal-pane/terminal-pane-layout-tree'
import { planTerminalLiveLayoutRemovals } from '../components/terminal-pane/terminal-live-layout-reconciliation'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import {
  ENV,
  LEAF_ID,
  SECOND_LEAF_ID,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

const TAB_ID = 'web-terminal-host-tab-1'
const mountedLeaves = [LEAF_ID, SECOND_LEAF_ID]

function snapshot(version: number, leaves = mountedLeaves): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    leaves.map((leafId) => ({
      type: 'terminal' as const,
      id: `host-tab-1::${leafId}`,
      parentTabId: 'host-tab-1',
      leafId,
      title: 'shell',
      isActive: leafId === LEAF_ID,
      status: 'ready' as const,
      terminal: `terminal-${leafId}`
    })),
    { snapshotVersion: version }
  )
}

function retiredSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    ...snapshot(3, [LEAF_ID]),
    retiredTerminalSurfaces: [
      {
        parentTabId: 'host-tab-1',
        leafId: SECOND_LEAF_ID,
        terminal: `terminal-${SECOND_LEAF_ID}`,
        ptyId: 'native-second',
        incarnationId: 'inc-second'
      }
    ]
  }
}

function createReconciliation() {
  let state = makeState()
  const mounted = new Set(mountedLeaves)
  const call = vi.fn(async () => {
    throw new Error('execution host unavailable')
  })

  function plan(secondPending = false): string[] {
    const root = state.terminalLayoutsByTabId[TAB_ID]?.root
    expect(root).toBeDefined()
    return planTerminalLiveLayoutRemovals(
      root,
      mounted,
      new Set(secondPending ? [SECOND_LEAF_ID] : [])
    )
  }

  return {
    call,
    plan,
    removeSecond: () => mounted.delete(SECOND_LEAF_ID),
    leaves: () => collectLeafIds(state.terminalLayoutsByTabId[TAB_ID].root!),
    async receive(incoming: RuntimeMobileSessionTabsResult) {
      const recovered = await recoverWebSessionTerminalOrphansBeforeApply(state, incoming, ENV, {
        call
      })
      expect(recovered).not.toBeNull()
      if (recovered) {
        state = { ...state, ...applyFreshWebSessionTabsSnapshot(state, recovered, ENV) }
      }
    }
  }
}

describe('host snapshot fences before split-pane retirement', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  it('keeps the pane when an older layout arrives', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    expect(view.plan()).toEqual([])
    await view.receive(retiredSnapshotWithVersion(1))
    expect(view.leaves()).toEqual(mountedLeaves)
    expect(view.plan()).toEqual([])
  })

  it('retains a missing pane when a newer layout cannot verify the host inventory', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan()
    await view.receive(snapshot(3, [LEAF_ID]))
    expect(view.call).toHaveBeenCalled()
    expect(view.leaves()).toContain(SECOND_LEAF_ID)
    expect(view.plan()).toEqual([])
  })

  it('defers proven retirement while the pane is pending and does not detach twice', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan()
    await view.receive(retiredSnapshot())
    expect(view.leaves()).toEqual([LEAF_ID])
    expect(view.plan(true)).toEqual([])
    expect(view.plan()).toEqual([SECOND_LEAF_ID])
    view.removeSecond()
    expect(view.plan()).toEqual([])
  })

  it('clears deferred retirement when the host reintroduces the leaf before detach', async () => {
    const view = createReconciliation()
    await view.receive(snapshot(2))
    view.plan()
    await view.receive(retiredSnapshot())
    expect(view.plan(true)).toEqual([])
    await view.receive(snapshot(4))
    expect(view.leaves()).toEqual(mountedLeaves)
    expect(view.plan()).toEqual([])
  })
})

function retiredSnapshotWithVersion(snapshotVersion: number): RuntimeMobileSessionTabsResult {
  return { ...retiredSnapshot(), snapshotVersion }
}

describe('a host snapshot that does not list a pane split here yet', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    clearWebSessionTerminalOrphanRecoveryForTests()
  })

  it('keeps the pane while the host has not recorded it', async () => {
    let state = makeState()
    // The host answers for a pane it has not recorded yet.
    const call = vi.fn(async () => ({
      id: 'resolve',
      ok: false as const,
      error: { code: 'terminal_not_found', message: 'terminal_not_found' }
    }))
    const receive = async (incoming: RuntimeMobileSessionTabsResult): Promise<void> => {
      const recovered = await recoverWebSessionTerminalOrphansBeforeApply(state, incoming, ENV, {
        call
      })
      expect(recovered).not.toBeNull()
      if (recovered) {
        state = { ...state, ...applyFreshWebSessionTabsSnapshot(state, recovered, ENV) }
      }
    }
    await receive(snapshot(2, [LEAF_ID]))
    // The split writes the window's tree before any later host frame can apply.
    state = {
      ...state,
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        [TAB_ID]: {
          ...state.terminalLayoutsByTabId[TAB_ID],
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: SECOND_LEAF_ID }
          }
        }
      }
    }
    const later = snapshot(3, [LEAF_ID])
    await receive({ ...later, tabs: later.tabs.map((tab) => ({ ...tab, title: 'vim' })) })

    expect(call).toHaveBeenCalledWith(expect.objectContaining({ method: 'terminal.resolvePane' }))
    expect(collectLeafIds(state.terminalLayoutsByTabId[TAB_ID].root!)).toEqual(mountedLeaves)
    expect(
      planTerminalLiveLayoutRemovals(
        state.terminalLayoutsByTabId[TAB_ID].root,
        mountedLeaves,
        new Set()
      )
    ).toEqual([])
  })
})

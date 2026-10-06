import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

function terminalSnapshot(hostTabId: string) {
  return makeSnapshot([
    {
      type: 'terminal',
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: hostTabId,
      isActive: true,
      status: 'ready',
      terminal: `${hostTabId}-pty`
    }
  ])
}

function apply(
  state: WebSessionTabsSyncState,
  snapshot: ReturnType<typeof makeSnapshot>,
  environmentId: string
): WebSessionTabsSyncState {
  return { ...state, ...applyWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

describe('session snapshot host isolation', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps WSL terminals and bindings when a Mac publishes an empty same-ID workspace', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const next = apply(wsl, makeSnapshot([]), 'mac')

    expect(next.tabsByWorktree[WT]).toEqual(wsl.tabsByWorktree[WT])
    expect(next.unifiedTabsByWorktree[WT]).toEqual(wsl.unifiedTabsByWorktree[WT])
    expect(next.ptyIdsByTabId).toEqual(wsl.ptyIdsByTabId)
    expect(next.terminalLayoutsByTabId).toEqual(wsl.terminalLayoutsByTabId)
  })

  it('keeps terminals from both servers, then closes only the publishing server’s tabs', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const both = apply(wsl, terminalSnapshot('mac-tab'), 'mac')

    expect(both.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId)).toEqual([
      'runtime:wsl',
      'runtime:mac'
    ])
    expect(both.tabsByWorktree[WT]).toHaveLength(2)
    const next = apply(both, makeSnapshot([]), 'mac')
    expect(next.tabsByWorktree[WT]).toEqual(wsl.tabsByWorktree[WT])
    expect(next.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId)).toEqual([
      'runtime:wsl'
    ])
    expect(next.ptyIdsByTabId).toEqual(wsl.ptyIdsByTabId)
  })

  it('rejects a snapshot that reuses a different server’s terminal identity', () => {
    const wsl = apply(makeState(), terminalSnapshot('shared-tab'), 'wsl')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const patch = applyWebSessionTabsSnapshot(wsl, terminalSnapshot('shared-tab'), 'mac', NOW)
      expect(patch).toBe(wsl)
      expect(warning).toHaveBeenCalledWith(
        '[web-session-tabs-sync] snapshot conflicts with another host’s terminal:',
        expect.objectContaining({ environmentId: 'mac', worktreeId: WT })
      )
    } finally {
      warning.mockRestore()
    }
  })

  it('keeps a foreign pending terminal even without a live PTY binding', () => {
    const hydrated = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const wsl = {
      ...hydrated,
      tabsByWorktree: {
        [WT]: hydrated.tabsByWorktree[WT]!.map((tab) => ({ ...tab, ptyId: null }))
      },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {}
    }
    const next = apply(wsl, makeSnapshot([]), 'mac')
    expect(next.tabsByWorktree[WT]).toEqual(wsl.tabsByWorktree[WT])
    expect(next.unifiedTabsByWorktree[WT]).toEqual(wsl.unifiedTabsByWorktree[WT])
  })

  it.each([true, false])(
    'rejects a foreign terminal ID in another workspace (bound: %s)',
    (bound) => {
      const hydrated = apply(makeState(), terminalSnapshot('shared-tab'), 'wsl')
      const wsl = bound
        ? hydrated
        : {
            ...hydrated,
            tabsByWorktree: {},
            ptyIdsByTabId: {},
            terminalLayoutsByTabId: {}
          }
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(
          applyWebSessionTabsSnapshot(
            wsl,
            { ...terminalSnapshot('shared-tab'), worktree: 'repo::/another-worktree' },
            'mac',
            NOW
          )
        ).toBe(wsl)
      } finally {
        warning.mockRestore()
      }
    }
  )

  it('still closes the publishing server’s last terminal', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const next = apply(wsl, makeSnapshot([]), 'wsl')
    expect(next.tabsByWorktree[WT]).toEqual([])
    expect(next.unifiedTabsByWorktree[WT]).toBeUndefined()
    expect(next.ptyIdsByTabId).toEqual({})
    expect(next.terminalLayoutsByTabId).toEqual({})
  })

  it('does not adopt a foreign provisional tab even when the incoming host names its ID', () => {
    const wsl = apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    const terminal = wsl.tabsByWorktree[WT]![0]!
    const provisional = {
      ...wsl,
      tabsByWorktree: { [WT]: [{ ...terminal, id: 'wsl-tab', ptyId: null }] },
      unifiedTabsByWorktree: {
        [WT]: wsl.unifiedTabsByWorktree[WT]!.map((tab) => ({
          ...tab,
          id: 'wsl-tab',
          entityId: 'wsl-tab'
        }))
      }
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(
        applyWebSessionTabsSnapshot(provisional, terminalSnapshot('wsl-tab'), 'mac', NOW)
      ).toBe(provisional)
    } finally {
      warning.mockRestore()
    }
  })

  it('does not wake subscribers when an unrelated host repeatedly publishes empty frames', () => {
    const store = createStore<WebSessionTabsSyncState>(() =>
      apply(makeState(), terminalSnapshot('wsl-tab'), 'wsl')
    )
    const notified = vi.fn()
    store.subscribe(notified)
    const initial = store.getState()
    for (let version = 1; version <= 128; version++) {
      store.setState((state) =>
        applyWebSessionTabsSnapshot(
          state,
          makeSnapshot([], { snapshotVersion: version }),
          'mac',
          NOW + version
        )
      )
    }
    expect(notified).not.toHaveBeenCalled()
    expect(store.getState()).toBe(initial)
  })
})

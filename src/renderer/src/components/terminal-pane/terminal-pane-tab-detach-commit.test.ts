import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import {
  createStore,
  LEAF_1,
  LEAF_2,
  SOURCE_TAB_ID,
  splitLayout,
  TARGET_GROUP_ID,
  unboundSplitLayout,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'

const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
const closeTerminalSurface = vi.fn(async () => {})
beforeEach(() => {
  toastErrorMock.mockClear()
  closeTerminalSurface.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { api: { session: { closeTerminalSurface } } })
})

/** Answers each call with the next result; an Error throws. */
function mainAnswering(results: (TerminalLeafMoveResult | Error)[]) {
  return vi.fn((_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
    const next = results.shift() ?? { status: 'not_held' }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
}

function managerWithPanes(paneIds: () => number[] = () => [1, 2]) {
  return {
    getPanes: vi.fn(() => paneIds().map((id) => ({ id }))),
    getLeafId: vi.fn((paneId: number): string | null => (paneId === 2 ? LEAF_2 : LEAF_1)),
    detachPaneForExternalMove: vi.fn(() => true)
  }
}

function detach(
  overrides: Partial<Parameters<typeof detachTerminalPaneToTab>[0]> & {
    store?: ReturnType<typeof createStore>
  }
) {
  const { store = createStore(), ...rest } = overrides
  return detachTerminalPaneToTab({
    getStore: () => store,
    manager: managerWithPanes(),
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId: SOURCE_TAB_ID,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID,
    ...rest
  })
}

const moved: TerminalLeafMoveResult = { status: 'moved', ptyId: 'remote:env-1@@terminal-1' }

describe('detachTerminalPaneToTab rolls a committed move forward', () => {
  it('refuses, silently, a pane whose PTY spawn is still in flight', async () => {
    const commitMove = mainAnswering([{ status: 'moved', ptyId: null }])
    const store = createStore(unboundSplitLayout())

    await expect(detach({ commitMove, store, sourceConnectPending: true })).resolves.toBeNull()

    expect(commitMove).not.toHaveBeenCalled()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('retries a thrown commit with the same request and applies the move', async () => {
    const commitMove = mainAnswering([new Error('write outcome unknown'), moved])
    const store = createStore()

    await expect(detach({ commitMove, store })).resolves.toMatchObject({ leafId: LEAF_2 })

    expect(commitMove).toHaveBeenCalledTimes(2)
    expect(commitMove.mock.calls[1]?.[0]).toEqual(commitMove.mock.calls[0]?.[0])
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('shows the failure toast and keeps the pane when main refuses or never answers', async () => {
    for (const results of [
      [{ status: 'refused', reason: 'pty_mismatch' } as const],
      [new Error('a'), new Error('b'), new Error('c')]
    ]) {
      toastErrorMock.mockClear()
      const store = createStore()
      const manager = managerWithPanes()

      await expect(
        detach({ commitMove: mainAnswering(results), store, manager })
      ).resolves.toBeNull()

      expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
      expect(store.createTab).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalledOnce()
    }
  })

  it('closes main’s new tab, without a toast, when the user closed the pane meanwhile', async () => {
    let paneIds = [1, 2]
    const manager = managerWithPanes(() => paneIds)
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        paneIds = [1]
        manager.getLeafId.mockImplementation((paneId) => (paneId === 1 ? LEAF_1 : null))
        return moved
      }
    )
    const store = createStore()

    await expect(detach({ commitMove, manager, store })).resolves.toBeNull()

    const targetTabId = commitMove.mock.calls[0]?.[0]?.targetTabId
    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: targetTabId },
      reason: 'cleanup'
    })
    expect(store.createTab).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('closes main’s new tab when the user closed the source tab meanwhile', async () => {
    const store = createStore()
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        store.tabsByWorktree[WORKTREE_ID] = []
        return moved
      }
    )

    await expect(detach({ commitMove, store })).resolves.toBeNull()

    expect(closeTerminalSurface).toHaveBeenCalledOnce()
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('finds the pane by its leaf when its pane id changed meanwhile', async () => {
    const manager = managerWithPanes(() => [1, 7])
    manager.getLeafId.mockImplementation((paneId) => (paneId === 1 ? LEAF_1 : LEAF_2))
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        manager.getLeafId.mockImplementation((paneId) =>
          paneId === 1 ? LEAF_1 : paneId === 7 ? LEAF_2 : null
        )
        return moved
      }
    )

    await expect(detach({ commitMove, manager })).resolves.toMatchObject({ leafId: LEAF_2 })

    expect(manager.detachPaneForExternalMove).toHaveBeenCalledWith(7)
  })

  it('moves the last pane by closing its source tab without killing the PTY', async () => {
    let paneIds = [1, 2]
    const manager = managerWithPanes(() => paneIds)
    const commitMove = vi.fn(
      async (_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
        paneIds = [2]
        return moved
      }
    )
    const store = createStore()

    await expect(detach({ commitMove, manager, store })).resolves.toMatchObject({
      leafId: LEAF_2
    })

    expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
    expect(store.createTab).toHaveBeenCalledOnce()
    expect(store.closeTab).toHaveBeenCalledWith(
      SOURCE_TAB_ID,
      expect.objectContaining({ localPtyTeardownOwnedExternally: true })
    )
  })

  it('binds the moved tab’s layout to the live PTY, not the saved one', async () => {
    const store = createStore(splitLayout())
    const saved = store.terminalLayoutsByTabId[SOURCE_TAB_ID]?.ptyIdsByLeafId?.[LEAF_2]
    expect(saved).toBeTruthy()

    const result = await detach({ livePtyId: 'pty-respawned', store })

    expect(result?.ptyId).toBe('pty-respawned')
    expect(store.terminalLayoutsByTabId['tab-detached']?.ptyIdsByLeafId?.[LEAF_2]).toBe(
      'pty-respawned'
    )
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import {
  createStore,
  LEAF_2,
  SOURCE_TAB_ID,
  TARGET_GROUP_ID,
  unboundSplitLayout,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'

const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))
beforeEach(() => {
  toastErrorMock.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const STAYED = /stays where it was/
const UNRESOLVED = /after Orca restarts/

type Results = (TerminalLeafMoveResult | Error | 'hang')[]

/** Answers each call with the next result; an Error throws, 'hang' never settles. */
function mainAnswering(results: Results) {
  return vi.fn((_request: TerminalLeafMoveRequest): Promise<TerminalLeafMoveResult> => {
    const next = results.shift() ?? { status: 'not_held' }
    if (next === 'hang') {
      return new Promise(() => {})
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
  })
}

function managerWithPanes(paneIds: () => number[] = () => [1, 2]) {
  return {
    getPanes: vi.fn(() => paneIds().map((id) => ({ id }))),
    getLeafId: vi.fn((): string | null => LEAF_2),
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

describe('detachTerminalPaneToTab against main (B1-2 review-1)', () => {
  // SF1: the late spawn result would graft the leaf back into its source tab.
  it('refuses, silently, a pane whose PTY spawn is still in flight', async () => {
    const commitMove = mainAnswering([{ status: 'moved', ptyId: null }])
    const store = createStore(unboundSplitLayout())

    await expect(detach({ commitMove, store, sourceConnectPending: true })).resolves.toBeNull()

    expect(commitMove).not.toHaveBeenCalled()
    expect(store.createTab).not.toHaveBeenCalled()
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  // SF2: the user closed the source meanwhile, so "it stays where it was" would be false.
  it('shows no toast when the undo finds the source tab closed', async () => {
    const commitMove = mainAnswering([moved, { status: 'retired' }])
    const manager = managerWithPanes()
    manager.getLeafId.mockReturnValueOnce(LEAF_2).mockReturnValue(null)

    await expect(detach({ commitMove, manager })).resolves.toBeNull()

    expect(commitMove.mock.calls[1]?.[0]).toMatchObject({ undo: true })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('shows no toast when the source pane closed while main committed', async () => {
    const commitMove = mainAnswering([moved, moved])
    let paneIds = [1, 2]
    const manager = managerWithPanes(() => paneIds)
    commitMove.mockImplementationOnce(async () => {
      paneIds = [1]
      return moved
    })
    manager.getLeafId.mockReturnValueOnce(LEAF_2).mockReturnValue(null)

    await expect(detach({ commitMove, manager })).resolves.toBeNull()

    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  // SF3: a throw can follow a durable write whose outcome is unknown; main may hold the move.
  it('asks main to undo after a thrown commit, and says the pane stayed once main agrees', async () => {
    const commitMove = mainAnswering([new Error('write outcome unknown'), { status: 'not_held' }])

    await expect(detach({ commitMove })).resolves.toBeNull()

    expect(commitMove).toHaveBeenCalledTimes(2)
    expect(commitMove.mock.calls[1]?.[0]).toEqual({ ...commitMove.mock.calls[0]?.[0], undo: true })
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(STAYED))
  })

  it('does not claim the pane stayed when main could not undo', async () => {
    const commitMove = mainAnswering([new Error('write failed'), new Error('still failing')])

    await expect(detach({ commitMove })).resolves.toBeNull()

    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(UNRESOLVED))
  })

  // N4: a throw after the pane left its source must not leave main holding the move alone.
  it('undoes the move when opening the new tab throws', async () => {
    const commitMove = mainAnswering([moved, moved])
    const store = createStore()
    vi.mocked(store.createTab).mockImplementation(() => {
      throw new Error('createTab failed')
    })

    await expect(detach({ commitMove, store })).resolves.toBeNull()

    expect(commitMove.mock.calls[1]?.[0]).toMatchObject({ undo: true })
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(STAYED))
  })

  // B1-2 review-2: a tab this window opened before the throw would disagree with main's undo.
  it('drops a half-opened target tab without killing its PTY and restores the source', async () => {
    const commitMove = mainAnswering([moved, moved])
    const store = createStore()
    const sourceLayout = store.terminalLayoutsByTabId[SOURCE_TAB_ID]
    vi.mocked(store.setActiveTab).mockImplementation(() => {
      throw new Error('setActiveTab failed')
    })

    await expect(detach({ commitMove, store })).resolves.toBeNull()

    expect(store.createTab).toHaveBeenCalledOnce()
    expect(store.closeTab).toHaveBeenCalledWith(
      'tab-detached',
      expect.objectContaining({
        localPtyTeardownOwnedExternally: true,
        remoteCloseOwnedByHost: true
      })
    )
    expect(store.terminalLayoutsByTabId[SOURCE_TAB_ID]).toBe(sourceLayout)
    expect(commitMove.mock.calls[1]?.[0]).toMatchObject({ undo: true })
  })

  // SF4: a stalled main must not wedge later drags of the pane.
  it('gives up on a stalled move, undoes it and lets the pane be dragged again', async () => {
    const commitMove = mainAnswering(['hang', { status: 'not_held' }, moved])

    await expect(detach({ commitMove, commitTimeoutMs: 20 })).resolves.toBeNull()
    expect(commitMove.mock.calls[1]?.[0]).toMatchObject({ undo: true })
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(STAYED))

    await expect(detach({ commitMove, commitTimeoutMs: 20 })).resolves.toMatchObject({
      leafId: LEAF_2
    })
    expect(commitMove).toHaveBeenCalledTimes(3)
  })
})

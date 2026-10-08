import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import type {
  TerminalTopologyReply,
  TerminalTopologySlice
} from '../../../../shared/terminal-topology-slice'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'
import {
  createTerminalTab,
  LEAF_1,
  LEAF_2,
  SOURCE_TAB_ID,
  splitLayout,
  TARGET_GROUP_ID,
  WORKTREE_ID
} from './terminal-pane-tab-detach-fixture'

const toastErrorMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

const OTHER_GROUP_ID = 'group-other'
const PTY = 'pty-right'
const initial = useAppStore.getState()
const state = () => useAppStore.getState()
const closeTerminalSurface = vi.fn(async (): Promise<TerminalTopologyReply> => ({}))

type MoveAnswer = TerminalLeafMoveResult & TerminalTopologyReply

function managerWithPanes(paneIds: () => number[] = () => [1, 2]) {
  return {
    getPanes: vi.fn(() => paneIds().map((id) => ({ id }))),
    getLeafId: vi.fn((paneId: number): string | null => (paneId === 2 ? LEAF_2 : LEAF_1)),
    detachPaneForExternalMove: vi.fn(() => true)
  }
}

/** Main's slice after the move: the source keeps LEAF_1, the new tab holds LEAF_2. */
function movedSlice(publishSeq: number, targetTabId: string): TerminalTopologySlice {
  return {
    hostId: 'local',
    worktreeId: WORKTREE_ID,
    publishSeq,
    revision: 2,
    tabs: [
      { id: SOURCE_TAB_ID, ptyId: 'pty-left', worktreeId: WORKTREE_ID, createdAt: 1 },
      { id: targetTabId, ptyId: PTY, worktreeId: WORKTREE_ID, createdAt: 2 }
    ],
    presentation: {},
    layouts: {
      [SOURCE_TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_1 },
        ptyIdsByLeafId: { [LEAF_1]: 'pty-left' }
      },
      [targetTabId]: {
        root: { type: 'leaf', leafId: LEAF_2 },
        ptyIdsByLeafId: { [LEAF_2]: PTY }
      }
    },
    sleeping: {}
  }
}

function seed(): void {
  const layout = splitLayout()
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE_ID]: [createTerminalTab(SOURCE_TAB_ID, 'pty-left')] },
    terminalLayoutsByTabId: {
      [SOURCE_TAB_ID]: { ...layout, ptyIdsByLeafId: { [LEAF_1]: 'pty-left', [LEAF_2]: PTY } }
    },
    ptyIdsByTabId: { [SOURCE_TAB_ID]: ['pty-left', PTY] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: SOURCE_TAB_ID,
          entityId: SOURCE_TAB_ID,
          groupId: OTHER_GROUP_ID,
          worktreeId: WORKTREE_ID,
          contentType: 'terminal',
          label: 'Terminal 2',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    groupsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: OTHER_GROUP_ID,
          worktreeId: WORKTREE_ID,
          activeTabId: SOURCE_TAB_ID,
          tabOrder: [SOURCE_TAB_ID]
        },
        { id: TARGET_GROUP_ID, worktreeId: WORKTREE_ID, activeTabId: null, tabOrder: [] }
      ]
    },
    activeGroupIdByWorktree: { [WORKTREE_ID]: OTHER_GROUP_ID },
    activeWorktreeId: WORKTREE_ID,
    terminalTopologySeqByWorktree: { [WORKTREE_ID]: 1 }
  })
}

function detach(
  answer: (request: TerminalLeafMoveRequest) => Promise<MoveAnswer>,
  manager = managerWithPanes()
) {
  const moveLeafToNewTab = vi.fn(answer)
  vi.stubGlobal('window', { api: { pty: { moveLeafToNewTab }, session: { closeTerminalSurface } } })
  const result = detachTerminalPaneToTab({
    getStore: state,
    subscribe: useAppStore.subscribe,
    manager,
    persistLayoutSnapshot: vi.fn(),
    sourcePaneId: 2,
    sourceTabId: SOURCE_TAB_ID,
    targetGroupId: TARGET_GROUP_ID,
    worktreeId: WORKTREE_ID
  })
  return { result, moveLeafToNewTab }
}

const targetTabIdOf = (move: { mock: { calls: [TerminalLeafMoveRequest][] } }): string =>
  move.mock.calls[0]?.[0].targetTabId ?? ''

function expectTargetTabShownOnce(targetTabId: string): void {
  const terminalIds = state().tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)
  expect(terminalIds).toEqual([SOURCE_TAB_ID, targetTabId])
  const target = state().groupsByWorktree[WORKTREE_ID].find((g) => g.id === TARGET_GROUP_ID)
  expect(target?.tabOrder).toEqual([targetTabId])
  expect(state().activeTabId).toBe(targetTabId)
  expect(state().ptyIdsByTabId[SOURCE_TAB_ID]).toEqual(['pty-left'])
  expect(state().ptyIdsByTabId[targetTabId]).toEqual([PTY])
  expect(closeTerminalSurface).not.toHaveBeenCalled()
}

beforeEach(() => {
  toastErrorMock.mockClear()
  closeTerminalSurface.mockReset()
  closeTerminalSurface.mockResolvedValue({})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  seed()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

describe('dragging a pane out to a new tab follows main’s move', () => {
  it('shows the new tab once when main’s push arrives before the reply', async () => {
    const { result, moveLeafToNewTab } = detach(async (request) => {
      // The reconciler detaches the source pane as soon as this push lands.
      state().applyTerminalTopologySlices([movedSlice(2, request.targetTabId)])
      return { status: 'moved', ptyId: PTY, publishSeq: 2 }
    })

    await expect(result).resolves.toMatchObject({ leafId: LEAF_2, ptyId: PTY })
    expect(moveLeafToNewTab).toHaveBeenCalledOnce()
    expectTargetTabShownOnce(targetTabIdOf(moveLeafToNewTab))
  })

  it('waits for main’s push when the reply arrives first', async () => {
    const { result, moveLeafToNewTab } = detach(async () => ({
      status: 'moved',
      ptyId: PTY,
      publishSeq: 2
    }))
    await vi.waitFor(() => expect(moveLeafToNewTab).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)

    state().applyTerminalTopologySlices([movedSlice(2, targetTabIdOf(moveLeafToNewTab))])

    await expect(result).resolves.toMatchObject({ leafId: LEAF_2 })
    expectTargetTabShownOnce(targetTabIdOf(moveLeafToNewTab))
  })

  it('closes main’s new tab when the user closed the pane meanwhile', async () => {
    closeTerminalSurface.mockResolvedValue({ publishSeq: 3 })
    const { result, moveLeafToNewTab } = detach(async () => {
      state().markPendingTerminalPane({
        worktreeId: WORKTREE_ID,
        tabId: SOURCE_TAB_ID,
        leafId: LEAF_2,
        change: 'remove'
      })
      return { status: 'moved', ptyId: PTY, publishSeq: 2 }
    })

    await expect(result).resolves.toBeNull()
    const targetTabId = targetTabIdOf(moveLeafToNewTab)
    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      target: { kind: 'tab', tabId: targetTabId },
      reason: 'cleanup'
    })
    // Main's push with the new tab can't show it meanwhile.
    state().applyTerminalTopologySlices([movedSlice(2, targetTabId)])
    expect(state().tabsByWorktree[WORKTREE_ID].map((tab) => tab.id)).toEqual([SOURCE_TAB_ID])
  })

  it('closes the source tab, keeping the PTY, when a sibling closed meanwhile', async () => {
    const closeTab = vi.spyOn(state(), 'closeTab')
    let paneIds = [1, 2]
    const { result } = detach(
      async (request) => {
        paneIds = [2]
        state().applyTerminalTopologySlices([movedSlice(2, request.targetTabId)])
        return { status: 'moved', ptyId: PTY, publishSeq: 2 }
      },
      managerWithPanes(() => paneIds)
    )

    await expect(result).resolves.toMatchObject({ leafId: LEAF_2 })
    expect(closeTab).toHaveBeenCalledWith(
      SOURCE_TAB_ID,
      expect.objectContaining({ localPtyTeardownOwnedExternally: true })
    )
  })

  it('shows the failure toast and keeps the pane when main refuses or the commit throws', async () => {
    for (const answer of [
      async (): Promise<MoveAnswer> => ({ status: 'refused', reason: 'pty_mismatch' }),
      async (): Promise<MoveAnswer> => {
        throw new Error('write failed')
      }
    ]) {
      toastErrorMock.mockClear()
      const manager = managerWithPanes()
      await expect(detach(answer, manager).result).resolves.toBeNull()
      expect(manager.detachPaneForExternalMove).not.toHaveBeenCalled()
      expect(state().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
      expect(toastErrorMock).toHaveBeenCalledOnce()
    }
  })

  it('ignores a repeat drop of a pane whose move is still committing', async () => {
    let release!: (answer: MoveAnswer) => void
    const first = detach(() => new Promise<MoveAnswer>((resolve) => (release = resolve)))
    await vi.waitFor(() => expect(first.moveLeafToNewTab).toHaveBeenCalledOnce())
    const repeat = detach(async () => ({ status: 'moved', ptyId: PTY }))

    await expect(repeat.result).resolves.toBeNull()
    expect(repeat.moveLeafToNewTab).not.toHaveBeenCalled()
    state().applyTerminalTopologySlices([movedSlice(2, targetTabIdOf(first.moveLeafToNewTab))])
    release({ status: 'moved', ptyId: PTY, publishSeq: 2 })
    await expect(first.result).resolves.toMatchObject({ leafId: LEAF_2 })
  })
})

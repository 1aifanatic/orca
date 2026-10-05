import type { AppState } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalLeafMoveRequest } from '../../../../shared/terminal-leaf-move'
import { commitTerminalSurfaceClose } from '@/store/terminals/terminal-surface-close-intent'
import {
  commitMoveWithRetry,
  reportMoveFailed,
  type CommitTerminalLeafMove
} from './terminal-pane-move-commit'
import type { PaneCwdEntry } from './resolve-split-cwd'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
export {
  isTerminalTabStripDropTarget,
  resolveTerminalTabStripDropTarget
} from './terminal-tab-strip-drop-target'
export type { TerminalTabStripDropTarget } from './terminal-tab-strip-drop-target'

export type TerminalPaneTabDetachStore = Pick<
  AppState,
  | 'closeTab'
  | 'createTab'
  | 'groupsByWorktree'
  | 'reorderUnifiedTabs'
  | 'setActiveTab'
  | 'setActiveTabType'
  | 'setTabLayout'
  | 'syncPaneDetachPtyOwnership'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>

type TerminalPaneTabDetachManager = {
  getPanes: () => readonly { id: number }[]
  getLeafId: (paneId: number) => string | null
  detachPaneForExternalMove: (paneId: number) => boolean
}

type SourcePaneCwd = Pick<PaneCwdEntry, 'cwd' | 'deferredSplitSpawn' | 'pendingCwd'> &
  Partial<Pick<PaneCwdEntry, 'confirmed'>>

export type DetachedTerminalPaneTab = {
  tab: TerminalTab
  leafId: string
  ptyId: string | null
}

function moveCreatedTabToIndex(args: {
  groupId: string
  store: TerminalPaneTabDetachStore
  tabId: string
  targetIndex: number | undefined
  worktreeId: string
}): void {
  if (args.targetIndex === undefined) {
    return
  }
  const group = args.store.groupsByWorktree[args.worktreeId]?.find(
    (candidate) => candidate.id === args.groupId
  )
  if (!group) {
    return
  }
  const orderWithoutCreatedTab = (group.tabOrder ?? []).filter((id) => id !== args.tabId)
  const insertionIndex = Math.min(Math.max(args.targetIndex, 0), orderWithoutCreatedTab.length)
  const nextOrder = [...orderWithoutCreatedTab]
  nextOrder.splice(insertionIndex, 0, args.tabId)
  args.store.reorderUnifiedTabs(args.groupId, nextOrder, { recordInteraction: false })
}

export type { CommitTerminalLeafMove } from './terminal-pane-move-commit'

type DetachTerminalPaneToTabArgs = {
  commitMove?: CommitTerminalLeafMove
  /** The PTY the source pane's transport is attached to now; it outranks the saved layout. */
  livePtyId?: string | null
  getStore: () => TerminalPaneTabDetachStore
  manager: TerminalPaneTabDetachManager | null
  persistLayoutSnapshot: () => void
  sourcePaneId: number
  sourcePaneCwd?: SourcePaneCwd
  /** The pane's transport is still awaiting its PTY id from a spawn or reattach. */
  sourceConnectPending?: boolean
  sourceTabId: string
  targetGroupId: string
  targetIndex?: number
  worktreeId: string
}

// Leaves whose move main is committing; a repeat drop meanwhile is a no-op.
const leavesMovingToNewTab = new Set<string>()

/**
 * Moves a pane into a new tab. Main commits the move (leaf, binding and pane-keyed records) before
 * the target tab exists here, so the moved pane's reattach never races a second owner (STA-9259).
 * Once main has moved it, this window only rolls forward: it never asks main to put it back.
 */
export async function detachTerminalPaneToTab(
  args: DetachTerminalPaneToTabArgs
): Promise<DetachedTerminalPaneTab | null> {
  const leafId = args.manager?.getLeafId(args.sourcePaneId)
  if (!leafId || leavesMovingToNewTab.has(leafId)) {
    return null
  }
  leavesMovingToNewTab.add(leafId)
  try {
    return await moveLeafToNewTab(args, leafId)
  } finally {
    leavesMovingToNewTab.delete(leafId)
  }
}

async function moveLeafToNewTab(
  args: DetachTerminalPaneToTabArgs,
  leafId: string
): Promise<DetachedTerminalPaneTab | null> {
  const initialStore = args.getStore()
  const targetGroupExists =
    initialStore.groupsByWorktree[args.worktreeId]?.some(
      (group) => group.id === args.targetGroupId
    ) ?? false
  if (!args.manager || !targetGroupExists || args.manager.getPanes().length <= 1) {
    return null
  }
  const persistedPtyId =
    initialStore.terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[leafId]
  const cwdDeferred = Boolean(
    args.sourcePaneCwd?.pendingCwd || args.sourcePaneCwd?.deferredSplitSpawn
  )
  // Why: a spawn result landing after the move binds SOURCE:leaf, and that bind grafts the leaf
  // back into the source tab beside its moved copy.
  if ((cwdDeferred || args.sourceConnectPending) && !persistedPtyId && !args.livePtyId) {
    return null
  }

  args.persistLayoutSnapshot()
  const request: TerminalLeafMoveRequest = {
    worktreeId: args.worktreeId,
    sourceTabId: args.sourceTabId,
    targetTabId: createBrowserUuid(),
    leafId,
    ptyId: args.livePtyId ?? persistedPtyId ?? null
  }
  if (args.commitMove) {
    const moved = await commitMoveWithRetry(args.commitMove, request)
    if (moved?.status !== 'moved' && moved?.status !== 'not_held') {
      console.warn('[terminal-pane-detach] main did not move the pane', moved)
      reportMoveFailed()
      return null
    }
  }
  return applyMove(args, request)
}

/** Applies a move main holds; the pane is found by its leaf, since its pane id may have changed. */
function applyMove(
  args: DetachTerminalPaneToTabArgs,
  request: TerminalLeafMoveRequest
): DetachedTerminalPaneTab | null {
  const { leafId, sourceTabId, targetTabId, worktreeId } = request
  const store = args.getStore()
  const manager = args.manager
  const paneId =
    manager?.getLeafId(args.sourcePaneId) === leafId
      ? args.sourcePaneId
      : manager?.getPanes().find((pane) => manager.getLeafId(pane.id) === leafId)?.id
  const detached =
    paneId === undefined || !store.tabsByWorktree[worktreeId]?.some((tab) => tab.id === sourceTabId)
      ? null
      : detachTerminalLayoutLeaf(store.terminalLayoutsByTabId[sourceTabId], leafId)
  if (!args.manager || paneId === undefined || !detached) {
    // Why: the user closed the pane or its tab meanwhile, so main's new tab holds a pane that is
    // gone here; close it the way any tab close reaches main.
    if (args.commitMove) {
      commitTerminalSurfaceClose(worktreeId, { kind: 'tab', tabId: targetTabId }, 'cleanup')
    }
    return null
  }
  const ptyId = args.livePtyId ?? detached.ptyId ?? null
  const detachedLayout = ptyId
    ? {
        ...detached.detachedLayout,
        ptyIdsByLeafId: { ...detached.detachedLayout.ptyIdsByLeafId, [leafId]: ptyId }
      }
    : detached.detachedLayout
  // A sibling closed meanwhile, so this pane is the source tab's last; the tab goes instead.
  const sourceEmptied = args.manager.getPanes().length <= 1
  // Why: remove the renderer pane only after the layout/PTY handoff has been
  // computed; the close callback detaches listeners but must not kill the PTY.
  if (!sourceEmptied && !args.manager.detachPaneForExternalMove(paneId)) {
    return null
  }

  const latestStore = args.getStore()
  const sourceShellOverride = latestStore.tabsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === sourceTabId
  )?.shellOverride
  const tab = latestStore.createTab(worktreeId, args.targetGroupId, sourceShellOverride, {
    id: targetTabId,
    activate: true,
    ...(detachedLayout.chatLeafId ? { viewMode: 'chat' as const } : {}),
    initialPtyId: ptyId ?? undefined,
    ...(!ptyId
      ? {
          pendingActivationSpawn: true,
          ...(args.sourcePaneCwd?.cwd ? { startupCwd: args.sourcePaneCwd.cwd } : {})
        }
      : { initialLeafId: leafId }),
    recordInteraction: true
  })
  const afterCreateStore = args.getStore()
  moveCreatedTabToIndex({
    groupId: args.targetGroupId,
    store: afterCreateStore,
    tabId: tab.id,
    targetIndex: args.targetIndex,
    worktreeId
  })
  afterCreateStore.setTabLayout(tab.id, detachedLayout)
  if (sourceEmptied) {
    // The new tab reattaches the PTY, so the source tab's close must not kill it.
    afterCreateStore.closeTab(sourceTabId, {
      reason: 'cleanup',
      recordInteraction: false,
      captureRecentlyClosed: false,
      localPtyTeardownOwnedExternally: true
    })
  } else {
    afterCreateStore.setTabLayout(sourceTabId, detached.sourceLayout)
    afterCreateStore.syncPaneDetachPtyOwnership({
      detachedLeafId: leafId,
      detachedPtyId: ptyId,
      sourceLayout: detached.sourceLayout,
      sourceTabId,
      targetTabId: tab.id
    })
  }
  afterCreateStore.setActiveTab(tab.id)
  afterCreateStore.setActiveTabType('terminal', worktreeId)

  return { tab, leafId, ptyId }
}

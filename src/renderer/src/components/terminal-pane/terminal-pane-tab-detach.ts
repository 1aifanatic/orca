import type { AppState } from '@/store'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  TerminalLeafMoveRequest,
  TerminalLeafMoveResult
} from '../../../../shared/terminal-leaf-move'
import {
  commitMoveWithin,
  MOVE_COMMIT_TIMEOUT_MS,
  reportMoveNotApplied,
  undoCommittedMove,
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

function withDetachedPtyFallback(args: {
  leafId: string
  ptyId: string | null
  detachedLayout: NonNullable<ReturnType<typeof detachTerminalLayoutLeaf>>['detachedLayout']
}): NonNullable<ReturnType<typeof detachTerminalLayoutLeaf>>['detachedLayout'] {
  if (!args.ptyId || args.detachedLayout.ptyIdsByLeafId?.[args.leafId]) {
    return args.detachedLayout
  }
  return {
    ...args.detachedLayout,
    ptyIdsByLeafId: {
      ...args.detachedLayout.ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  }
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
  /** Bound on each main round trip; tests shorten it. */
  commitTimeoutMs?: number
  fallbackPtyId?: string | null
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

// Leaves whose move main is committing; a repeat drop meanwhile is a no-op (review-2 N3).
const leavesMovingToNewTab = new Set<string>()

/**
 * Moves a pane into a new tab. Main commits the move (leaf, binding and pane-keyed records) before
 * the target tab exists here, so the moved pane's reattach never races a second owner (STA-9259).
 */
export async function detachTerminalPaneToTab(
  args: DetachTerminalPaneToTabArgs
): Promise<DetachedTerminalPaneTab | null> {
  const sourceLeafId = args.manager?.getLeafId(args.sourcePaneId)
  if (!sourceLeafId || leavesMovingToNewTab.has(sourceLeafId)) {
    return null
  }
  leavesMovingToNewTab.add(sourceLeafId)
  try {
    return await detachLeafToNewTab(args, sourceLeafId)
  } finally {
    leavesMovingToNewTab.delete(sourceLeafId)
  }
}

/** Puts main back in step after a move this window did not apply, then tells the user. */
async function settleUnappliedMove(
  args: DetachTerminalPaneToTabArgs,
  request: TerminalLeafMoveRequest,
  paneDetached = false
): Promise<null> {
  const undone = await undoCommittedMove(
    args.commitMove,
    request,
    args.commitTimeoutMs ?? MOVE_COMMIT_TIMEOUT_MS
  )
  const sourceGone =
    !args.manager?.getPanes().some((pane) => pane.id === args.sourcePaneId) ||
    !args.getStore().tabsByWorktree[args.worktreeId]?.some((tab) => tab.id === args.sourceTabId)
  // Why: the user closed the pane or its tab meanwhile; "it stays where it was" would be false.
  if (undone === 'retired' || (sourceGone && !paneDetached)) {
    return null
  }
  reportMoveNotApplied(undone === 'failed' ? 'unknown' : 'stayed')
  return null
}

async function detachLeafToNewTab(
  args: DetachTerminalPaneToTabArgs,
  sourceLeafId: string
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
    initialStore.terminalLayoutsByTabId[args.sourceTabId]?.ptyIdsByLeafId?.[sourceLeafId]
  const cwdDeferred = Boolean(
    args.sourcePaneCwd?.pendingCwd || args.sourcePaneCwd?.deferredSplitSpawn
  )
  // Why: a spawn result landing after the move binds SOURCE:leaf, and that bind grafts the leaf
  // back into the source tab beside its moved copy.
  if ((cwdDeferred || args.sourceConnectPending) && !persistedPtyId && !args.fallbackPtyId) {
    return null
  }

  args.persistLayoutSnapshot()
  const planned = detachTerminalLayoutLeaf(
    args.getStore().terminalLayoutsByTabId[args.sourceTabId],
    sourceLeafId
  )
  if (!planned) {
    return null
  }
  // Why: the live transport id is what the PTY is bound to now; the snapshot can lag a respawn.
  const request: TerminalLeafMoveRequest = {
    worktreeId: args.worktreeId,
    sourceTabId: args.sourceTabId,
    targetTabId: createBrowserUuid(),
    leafId: sourceLeafId,
    ptyId: args.fallbackPtyId ?? planned.ptyId ?? null
  }
  if (args.commitMove) {
    let moved: TerminalLeafMoveResult
    try {
      moved = await commitMoveWithin(
        args.commitMove,
        request,
        args.commitTimeoutMs ?? MOVE_COMMIT_TIMEOUT_MS
      )
    } catch (error) {
      console.warn('[terminal-pane-detach] main did not answer the move', error)
      // Why: a throw can follow a write whose outcome is unknown, or a late commit; undo either.
      return settleUnappliedMove(args, request)
    }
    if (moved.status === 'refused') {
      console.warn('[terminal-pane-detach] main refused the move; pane stays put', {
        reason: moved.reason
      })
      reportMoveNotApplied('stayed')
      return null
    }
  }
  return applyCommittedMove(args, request, sourceLeafId)
}

async function applyCommittedMove(
  args: DetachTerminalPaneToTabArgs,
  request: TerminalLeafMoveRequest,
  sourceLeafId: string
): Promise<DetachedTerminalPaneTab | null> {
  const store = args.getStore()
  const detached = detachTerminalLayoutLeaf(
    store.terminalLayoutsByTabId[args.sourceTabId],
    sourceLeafId
  )
  if (!args.manager || !detached || args.manager.getLeafId(args.sourcePaneId) !== sourceLeafId) {
    console.warn('[terminal-pane-detach] pane changed while main committed its move', {
      sourceTabId: args.sourceTabId,
      targetTabId: request.targetTabId
    })
    // Why: main already holds the leaf in the new tab; put it back so both sides agree again.
    return settleUnappliedMove(args, request)
  }

  const ptyId = args.fallbackPtyId ?? detached.ptyId ?? null
  const detachedLayout = withDetachedPtyFallback({
    leafId: sourceLeafId,
    ptyId,
    detachedLayout: detached.detachedLayout
  })

  // Why: remove the renderer pane only after the layout/PTY handoff has been
  // computed; the close callback detaches listeners but must not kill the PTY.
  if (!args.manager.detachPaneForExternalMove(args.sourcePaneId)) {
    return settleUnappliedMove(args, request)
  }

  try {
    const latestStore = args.getStore()
    const sourceShellOverride = latestStore.tabsByWorktree[args.worktreeId]?.find(
      (candidate) => candidate.id === args.sourceTabId
    )?.shellOverride
    const tab = latestStore.createTab(args.worktreeId, args.targetGroupId, sourceShellOverride, {
      id: request.targetTabId,
      activate: true,
      ...(detachedLayout.chatLeafId ? { viewMode: 'chat' as const } : {}),
      initialPtyId: ptyId ?? undefined,
      ...(!ptyId
        ? {
            pendingActivationSpawn: true,
            ...(args.sourcePaneCwd?.cwd ? { startupCwd: args.sourcePaneCwd.cwd } : {})
          }
        : { initialLeafId: sourceLeafId }),
      recordInteraction: true
    })
    const afterCreateStore = args.getStore()
    moveCreatedTabToIndex({
      groupId: args.targetGroupId,
      store: afterCreateStore,
      tabId: tab.id,
      targetIndex: args.targetIndex,
      worktreeId: args.worktreeId
    })
    afterCreateStore.setTabLayout(args.sourceTabId, detached.sourceLayout)
    afterCreateStore.setTabLayout(tab.id, detachedLayout)
    afterCreateStore.syncPaneDetachPtyOwnership({
      detachedLeafId: sourceLeafId,
      detachedPtyId: ptyId,
      sourceLayout: detached.sourceLayout,
      sourceTabId: args.sourceTabId,
      targetTabId: tab.id
    })
    afterCreateStore.setActiveTab(tab.id)
    afterCreateStore.setActiveTabType('terminal', args.worktreeId)
    return { tab, leafId: sourceLeafId, ptyId }
  } catch (error) {
    console.warn('[terminal-pane-detach] could not open the moved pane; putting it back', error)
    return settleUnappliedMove(args, request, true)
  }
}

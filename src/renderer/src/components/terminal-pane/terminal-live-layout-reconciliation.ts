import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../../../../shared/terminal-tab-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { collectLeafIds } from '../../../../shared/terminal-pane-layout-tree'
import { removeLeafFromTree } from './terminal-layout-leaf-detach'

export type TerminalLiveLayoutInsertion = {
  sourceLeafId: string
  sourceLeafIds: string[]
  newLeafId: string
  direction: TerminalPaneSplitDirection
  placement: 'before' | 'after'
  ratio?: number
}

function leftmostLeafId(node: TerminalPaneLayoutNode): string {
  return node.type === 'leaf' ? node.leafId : leftmostLeafId(node.first)
}

function rightmostMountedLeafId(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): string | null {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId) ? node.leafId : null
  }
  return (
    rightmostMountedLeafId(node.second, mountedLeafIds) ??
    rightmostMountedLeafId(node.first, mountedLeafIds)
  )
}

function leftmostMountedLeafId(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): string | null {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId) ? node.leafId : null
  }
  return (
    leftmostMountedLeafId(node.first, mountedLeafIds) ??
    leftmostMountedLeafId(node.second, mountedLeafIds)
  )
}

function hasMountedLeaf(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): boolean {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId)
  }
  return hasMountedLeaf(node.first, mountedLeafIds) || hasMountedLeaf(node.second, mountedLeafIds)
}

function mountedLeafIdsIn(
  node: TerminalPaneLayoutNode,
  mountedLeafIds: ReadonlySet<string>
): string[] {
  if (node.type === 'leaf') {
    return mountedLeafIds.has(node.leafId) ? [node.leafId] : []
  }
  return [
    ...mountedLeafIdsIn(node.first, mountedLeafIds),
    ...mountedLeafIdsIn(node.second, mountedLeafIds)
  ]
}

/**
 * Mounted leaves the layout no longer names: main closed, moved or retired them, so a pane still
 * mounted for one is a ghost. A pane this window made that main has not named yet is pending, not
 * gone. An empty layout plans nothing — absence of a tree is not evidence about any pane.
 */
export function planTerminalLiveLayoutRemovals(
  root: TerminalPaneLayoutNode | null | undefined,
  currentLeafIds: Iterable<string>,
  pendingLeafIds: ReadonlySet<string>
): string[] {
  if (!root) {
    return []
  }
  const layoutLeafIds = new Set(collectLeafIds(root))
  return [...currentLeafIds].filter(
    (leafId) => !layoutLeafIds.has(leafId) && !pendingLeafIds.has(leafId)
  )
}

export function planTerminalLiveLayoutInsertions(
  root: TerminalPaneLayoutNode | null | undefined,
  currentLeafIds: Iterable<string>
): TerminalLiveLayoutInsertion[] {
  if (!root) {
    return []
  }

  const mountedLeafIds = new Set(currentLeafIds)
  const insertions: TerminalLiveLayoutInsertion[] = []

  const ensureSubtree = (node: TerminalPaneLayoutNode): boolean => {
    if (node.type === 'leaf') {
      return mountedLeafIds.has(node.leafId)
    }

    const firstHasMounted = hasMountedLeaf(node.first, mountedLeafIds)
    const secondHasMounted = hasMountedLeaf(node.second, mountedLeafIds)
    if (!firstHasMounted && !secondHasMounted) {
      return false
    }

    // Why: bridge the current split before filling nested descendants; once a
    // child subtree is split internally, PaneManager can no longer wrap it as
    // this split's sibling using a leaf-only splitPane call.
    if (firstHasMounted && !secondHasMounted) {
      const sourceLeafId = rightmostMountedLeafId(node.first, mountedLeafIds)
      const newLeafId = leftmostLeafId(node.second)
      if (sourceLeafId && !mountedLeafIds.has(newLeafId)) {
        insertions.push({
          sourceLeafId,
          sourceLeafIds: mountedLeafIdsIn(node.first, mountedLeafIds),
          newLeafId,
          direction: node.direction,
          placement: 'after',
          ratio: node.ratio
        })
        mountedLeafIds.add(newLeafId)
      }
      ensureSubtree(node.second)
      ensureSubtree(node.first)
      return true
    }

    if (!firstHasMounted && secondHasMounted) {
      const sourceLeafId = leftmostMountedLeafId(node.second, mountedLeafIds)
      const newLeafId = leftmostLeafId(node.first)
      if (sourceLeafId && !mountedLeafIds.has(newLeafId)) {
        insertions.push({
          sourceLeafId,
          sourceLeafIds: mountedLeafIdsIn(node.second, mountedLeafIds),
          newLeafId,
          direction: node.direction,
          placement: 'before',
          ratio: node.ratio
        })
        mountedLeafIds.add(newLeafId)
      }
      ensureSubtree(node.first)
      ensureSubtree(node.second)
      return true
    }

    ensureSubtree(node.first)
    ensureSubtree(node.second)
    return true
  }

  ensureSubtree(root)
  return insertions
}

/** This tab's panes the window added or closed ahead of main's layout. */
export type TerminalPendingLeaves = { added: ReadonlySet<string>; removed: ReadonlySet<string> }

function withoutLeaves(
  root: TerminalPaneLayoutNode,
  leafIds: ReadonlySet<string>
): TerminalPaneLayoutNode | null {
  let next: TerminalPaneLayoutNode | null = root
  for (const leafId of leafIds) {
    next = next && removeLeafFromTree(next, leafId).node
  }
  return next
}

/**
 * Makes the mounted panes follow the store's layout: removed leaves detach (no kill; the PTY may
 * live on in another tab), then missing leaves mount and attach or spawn, then geometry applies
 * in place. Pending leaves win over the layout until main has them. It writes no layout back: the
 * store already holds this one. Returns whether panes were added or removed.
 */
export function reconcileMountedTerminalLayout(
  manager: Pick<
    PaneManager,
    | 'getPanes'
    | 'getNumericIdForLeaf'
    | 'splitPaneAroundLeafIds'
    | 'detachPaneForExternalMove'
    | 'applyLayoutGeometry'
  >,
  layout: Pick<TerminalLayoutSnapshot, 'ptyIdsByLeafId'> & { root: TerminalPaneLayoutNode },
  pending: TerminalPendingLeaves
): boolean {
  const root = withoutLeaves(layout.root, pending.removed)
  if (!root) {
    return false
  }
  const mountedLeafIds = (): string[] => manager.getPanes().map((pane) => pane.leafId)
  // Removals first, so insertions anchor on the panes that stay.
  const detached = planTerminalLiveLayoutRemovals(root, mountedLeafIds(), pending.added).filter(
    (leafId) => {
      const paneId = manager.getNumericIdForLeaf(leafId)
      return paneId !== null && manager.detachPaneForExternalMove(paneId)
    }
  )
  let inserted = false
  for (const insertion of planTerminalLiveLayoutInsertions(root, mountedLeafIds())) {
    const sourcePaneId = manager.getNumericIdForLeaf(insertion.sourceLeafId)
    if (sourcePaneId === null || manager.getNumericIdForLeaf(insertion.newLeafId) !== null) {
      continue
    }
    // An unbound leaf spawns through the pane's normal mount, like a local split.
    const ptyId = layout.ptyIdsByLeafId?.[insertion.newLeafId]
    const ratio =
      insertion.ratio === undefined || insertion.placement === 'after'
        ? insertion.ratio
        : 1 - insertion.ratio
    const created = manager.splitPaneAroundLeafIds(
      insertion.sourceLeafIds,
      sourcePaneId,
      insertion.direction,
      {
        ...(ratio !== undefined && { ratio }),
        ...(ptyId && { ptyId }),
        leafId: insertion.newLeafId,
        placement: insertion.placement
      }
    )
    inserted ||= created !== null
  }
  manager.applyLayoutGeometry(root)
  return detached.length > 0 || inserted
}

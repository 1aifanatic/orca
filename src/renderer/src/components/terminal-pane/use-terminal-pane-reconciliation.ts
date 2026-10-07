import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  applyExpandedLayoutTo,
  cancelPendingPaneSizeRefreshFrames,
  restoreExpandedLayoutFrom
} from './expand-collapse'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { resolvePaneKeyForManager } from '@/lib/pane-manager/pane-key-resolution'
import {
  reconcileMountedTerminalLayout,
  trackRetiredLeafIds
} from './terminal-live-layout-reconciliation'
import { collectLeafIds } from './terminal-pane-layout-tree'
import { useTerminalPaneProcessExitActions } from './use-terminal-pane-process-exit-actions'
import type { TerminalPaneCloseController } from './use-terminal-pane-close-actions'

export function useTerminalPaneReconciliation(controller: TerminalPaneCloseController) {
  const {
    activityIsolationSnapshotRef,
    closeTerminalLinkActions,
    containerRef,
    isActive,
    isRendererVisible,
    isolatedPaneKey,
    managerRef,
    paneCount,
    paneLayoutRevision,
    paneTransportsRef,
    pendingPaneSizeRefreshFrameIdsRef,
    restoredLayout,
    tabId
  } = controller
  // Leaves the last layout named, and the ones it has since dropped whose panes
  // are still mounted; a removal needs the layout to have named the leaf first.
  const layoutLeafIdsRef = useRef<ReadonlySet<string>>(new Set())
  const retiredLeafIdsRef = useRef<ReadonlySet<string>>(new Set())

  useEffect(() => {
    closeTerminalLinkActions()
  }, [closeTerminalLinkActions, isActive, isRendererVisible, paneLayoutRevision])

  useEffect(() => {
    const manager = managerRef.current
    const root = restoredLayout.root
    if (!manager || !root) {
      return
    }
    const layoutLeafIds = new Set(collectLeafIds(root))
    const retiredLeafIds = trackRetiredLeafIds({
      retiredLeafIds: retiredLeafIdsRef.current,
      previousLayoutLeafIds: layoutLeafIdsRef.current,
      layoutLeafIds,
      mountedLeafIds: manager.getPanes().map((pane) => pane.leafId)
    })
    layoutLeafIdsRef.current = layoutLeafIds
    retiredLeafIdsRef.current = retiredLeafIds
    const panesChanged = reconcileMountedTerminalLayout(
      manager,
      { root, ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId },
      retiredLeafIds,
      (paneId) => {
        const transport = paneTransportsRef.current.get(paneId)
        return !transport || transport.isConnectPending?.() === true
      }
    )
    if (!panesChanged) {
      return
    }
    const activePaneId = restoredLayout.activeLeafId
      ? manager.getNumericIdForLeaf(restoredLayout.activeLeafId)
      : null
    const fallbackActivePaneId = manager.getActivePane()?.id ?? manager.getPanes()[0]?.id ?? null
    const nextActivePaneId = activePaneId ?? fallbackActivePaneId
    if (nextActivePaneId !== null) {
      manager.setActivePane(nextActivePaneId, { focus: isActive })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [isActive, paneCount, restoredLayout])

  useLayoutEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    const scheduleRefit = (): number =>
      requestAnimationFrame(() => {
        const manager = managerRef.current
        if (!manager) {
          return
        }
        for (const pane of manager.getPanes()) {
          safeFit(pane)
        }
      })
    if (isolatedPaneKey === null) {
      restoreExpandedLayoutFrom(snapshots)
      const frame = scheduleRefit()
      return () => cancelAnimationFrame(frame)
    }
    const manager = managerRef.current
    const resolution = resolvePaneKeyForManager(tabId, isolatedPaneKey, manager)
    const resolvedPaneId = resolution.status === 'resolved' ? resolution.numericPaneId : null
    const applied =
      resolvedPaneId !== null &&
      ((manager?.getPanes().length ?? 0) <= 1 ||
        applyExpandedLayoutTo(resolvedPaneId, {
          managerRef,
          containerRef,
          expandedStyleSnapshotRef: activityIsolationSnapshotRef
        }))
    if (!applied) {
      restoreExpandedLayoutFrom(snapshots)
      const root = containerRef.current?.firstElementChild
      if (root instanceof HTMLElement) {
        snapshots.set(root, { display: root.style.display, flex: root.style.flex })
        root.style.display = 'none'
      }
      const frame = scheduleRefit()
      return () => cancelAnimationFrame(frame)
    }
    const frame = scheduleRefit()
    return () => cancelAnimationFrame(frame)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [isolatedPaneKey, paneCount, tabId])

  useEffect(() => {
    const snapshots = activityIsolationSnapshotRef.current
    return () => {
      restoreExpandedLayoutFrom(snapshots)
      cancelPendingPaneSizeRefreshFrames({ pendingPaneSizeRefreshFrameIdsRef })
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Preserve the pre-split dependency contract.
  }, [])

  const processExitActions = useTerminalPaneProcessExitActions(controller)

  return processExitActions
}

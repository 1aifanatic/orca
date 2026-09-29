import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncWindowGraph
} from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'

export function collectRendererPublishedEmptyTerminalPanes(
  graph: Pick<RuntimeSyncWindowGraph, 'mobileSessionTabs' | 'unchangedMobileSessionWorktrees'>,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>,
  acceptedSnapshots: ReadonlyMap<string, { rendererTabIdentityKeys: ReadonlySet<string> }>
): { emptyPaneWorktrees: Map<string, string>; boundPtyIds: Set<string> } {
  const worktrees = new Set([
    ...(graph.mobileSessionTabs?.map((snapshot) => snapshot.worktree) ?? []),
    ...(graph.unchangedMobileSessionWorktrees ?? [])
  ])
  const emptyPaneWorktrees = new Map<string, string>()
  const boundPtyIds = new Set<string>()
  for (const worktreeId of worktrees) {
    const accepted = acceptedSnapshots.get(worktreeId)
    for (const tab of snapshots.get(worktreeId)?.tabs ?? []) {
      // Host-preserved tabs cannot stand in for a pane the renderer actually published.
      if (
        tab.type !== 'terminal' ||
        !accepted?.rendererTabIdentityKeys.has(`${tab.parentTabId}::${tab.leafId}`)
      ) {
        continue
      }
      if (tab.ptyId) {
        boundPtyIds.add(tab.ptyId)
      } else {
        emptyPaneWorktrees.set(makePaneKey(tab.parentTabId, tab.leafId), worktreeId)
      }
    }
  }
  return { emptyPaneWorktrees, boundPtyIds }
}

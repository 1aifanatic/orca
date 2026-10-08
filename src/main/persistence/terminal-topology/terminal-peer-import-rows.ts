import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'

/**
 * A pull's rows over main's: on a worktree main has published past what the window merged against,
 * main's tabs and their layouts stand, and the pull adds only tabs main neither holds nor closed.
 */
export function overNewerMainRows(
  pull: WorkspaceSessionPatch,
  main: WorkspaceSessionState,
  publishedSince: (worktreeId: string) => boolean
): WorkspaceSessionPatch {
  if (!pull.tabsByWorktree) {
    return pull
  }
  const tabsByWorktree = { ...pull.tabsByWorktree }
  const layouts = { ...pull.terminalLayoutsByTabId }
  const worktreeIds = new Set([
    ...Object.keys(main.tabsByWorktree),
    ...Object.keys(pull.tabsByWorktree)
  ])
  for (const worktreeId of [...worktreeIds].filter(publishedSince)) {
    const mainTabs = main.tabsByWorktree[worktreeId] ?? []
    const held = new Set(mainTabs.map((tab) => tab.id))
    const hostOnly = (pull.tabsByWorktree[worktreeId] ?? []).filter(
      (tab) =>
        !held.has(tab.id) &&
        !hasClosedTerminalTabRecord(main.closedTerminalTabTombstonesByTabId, tab.id, worktreeId)
    )
    for (const tab of mainTabs) {
      const layout = main.terminalLayoutsByTabId[tab.id]
      if (layout) {
        layouts[tab.id] = layout
      } else {
        delete layouts[tab.id]
      }
    }
    tabsByWorktree[worktreeId] = [...mainTabs, ...hostOnly]
  }
  return {
    ...pull,
    tabsByWorktree,
    ...(pull.terminalLayoutsByTabId && { terminalLayoutsByTabId: layouts })
  }
}

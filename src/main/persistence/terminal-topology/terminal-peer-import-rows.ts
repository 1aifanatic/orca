import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { hasHostAuthoritativeTerminalMembership } from './terminal-topology-membership'

/**
 * A pull's rows over main's. Main's tabs, their layouts and pane incarnations stand on a worktree
 * main has published past what the window merged against, where the pull adds only tabs main
 * neither holds nor closed, and in a repo main has fenced, where it adds none (as main's
 * membership rebase did).
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
  // Tabs whose layout and incarnations are main's, and pulled tabs main's membership drops.
  const mainTabIds = new Set<string>()
  const droppedTabIds = new Set<string>()
  const worktreeIds = new Set([
    ...Object.keys(main.tabsByWorktree),
    ...Object.keys(pull.tabsByWorktree)
  ])
  for (const worktreeId of worktreeIds) {
    const addsHostTabs = publishedSince(worktreeId)
    if (!addsHostTabs && !hasHostAuthoritativeTerminalMembership(main, worktreeId)) {
      continue
    }
    const mainTabs = main.tabsByWorktree[worktreeId] ?? []
    const held = new Set(mainTabs.map((tab) => tab.id))
    const hostOnly = (pull.tabsByWorktree[worktreeId] ?? []).filter((tab) => !held.has(tab.id))
    const added = addsHostTabs
      ? hostOnly.filter(
          (tab) =>
            !hasClosedTerminalTabRecord(main.closedTerminalTabTombstonesByTabId, tab.id, worktreeId)
        )
      : []
    for (const tab of hostOnly) {
      if (!added.includes(tab)) {
        droppedTabIds.add(tab.id)
        delete layouts[tab.id]
      }
    }
    for (const tab of mainTabs) {
      mainTabIds.add(tab.id)
      const layout = main.terminalLayoutsByTabId[tab.id]
      if (layout) {
        layouts[tab.id] = layout
      } else {
        delete layouts[tab.id]
      }
    }
    tabsByWorktree[worktreeId] = [...mainTabs, ...added]
  }
  const tabOf = ([paneKey]: [string, string]): string => parsePaneKey(paneKey)?.tabId ?? ''
  return {
    ...pull,
    tabsByWorktree,
    ...(pull.terminalLayoutsByTabId && { terminalLayoutsByTabId: layouts }),
    ...(pull.terminalPtyIncarnationsByPaneKey && {
      terminalPtyIncarnationsByPaneKey: Object.fromEntries([
        ...Object.entries(pull.terminalPtyIncarnationsByPaneKey).filter(
          (entry) => !mainTabIds.has(tabOf(entry)) && !droppedTabIds.has(tabOf(entry))
        ),
        ...Object.entries(main.terminalPtyIncarnationsByPaneKey ?? {}).filter((entry) =>
          mainTabIds.has(tabOf(entry))
        )
      ])
    })
  }
}

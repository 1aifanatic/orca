import { isDeepStrictEqual } from 'node:util'
import type {
  TerminalLayoutSetRequest,
  TerminalLayoutSetResult
} from '../../../shared/terminal-layout-set'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

const sortedLeafIds = (root: TerminalPaneLayoutNode | null | undefined): string[] =>
  collectLayoutLeafIdsInOrder(root).sort()

/**
 * Replaces a tab's tree in the worktree's home partition with the window's, when it holds exactly
 * the same panes. A geometry edit never adds, removes or moves a pane; a tree that would is
 * refused, not merged. `session` is null when nothing changes.
 */
export function planTerminalLayoutSet(
  home: WorkspaceSessionState,
  { worktreeId, tabId, root }: TerminalLayoutSetRequest
): { result: TerminalLayoutSetResult; session: WorkspaceSessionState | null } {
  const layout = home.terminalLayoutsByTabId?.[tabId]
  if (!layout?.root || !home.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId)) {
    return { result: { status: 'refused', reason: 'tab_not_held' }, session: null }
  }
  if (!isDeepStrictEqual(sortedLeafIds(layout.root), sortedLeafIds(root))) {
    return { result: { status: 'refused', reason: 'leaves_differ' }, session: null }
  }
  return {
    result: { status: 'committed' },
    session: isDeepStrictEqual(layout.root, root)
      ? null
      : {
          ...home,
          terminalLayoutsByTabId: { ...home.terminalLayoutsByTabId, [tabId]: { ...layout, root } }
        }
  }
}

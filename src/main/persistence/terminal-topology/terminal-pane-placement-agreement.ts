import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'

/**
 * Low-cardinality: it lands on the `persistence.pty-binding` span. `absent` counts new leaves with
 * no placement, which only the mint and graft can place; it should read zero before they go.
 */
export type TerminalPanePlacementAgreement =
  | 'absent'
  | 'leaf_present'
  | 'agrees'
  | 'tab_exists'
  | 'tab_missing'
  | 'parent_missing'
  | 'root_occupied'

/**
 * Whether placement names the tab's current shape, read before the binding write. The write
 * applies placement only on `agrees`; every other verdict keeps the mint and graft.
 */
export function terminalPanePlacementAgreement(
  placement: TerminalPanePlacement | undefined,
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  leafId: string
): TerminalPanePlacementAgreement {
  const tabExists = session.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) === true
  const root = session.terminalLayoutsByTabId?.[tabId]?.root ?? null
  if (tabExists && layoutContainsLeafId(root, leafId)) {
    return 'leaf_present'
  }
  if (!placement) {
    return 'absent'
  }
  switch (placement.kind) {
    case 'new-tab':
      return tabExists ? 'tab_exists' : 'agrees'
    case 'root':
      return !tabExists ? 'tab_missing' : root ? 'root_occupied' : 'agrees'
    case 'split':
      return !tabExists
        ? 'tab_missing'
        : layoutContainsLeafId(root, placement.parentLeafId)
          ? 'agrees'
          : 'parent_missing'
  }
}

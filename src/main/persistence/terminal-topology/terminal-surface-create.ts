import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import type {
  TerminalSurfaceCreateRequest,
  TerminalSurfaceCreateResult
} from '../../../shared/terminal-surface-create'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { cloneWorkspaceSessionState } from '../restoring-sessions/session-owner-fields'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import { placeTerminalPane } from './terminal-pane-placement-apply'
import {
  advanceTerminalTopologyRevision,
  startsOrAdvancesTerminalFence
} from './terminal-topology-membership'

/**
 * Records a tab or pane the window created in the worktree's home partition, unbound; its spawn
 * later only binds. A new tab needs a `new-tab` placement and an id never closed; a pane joins an
 * empty tree, or a split of a pane main holds. `session` is null when nothing changes.
 */
export function planTerminalSurfaceCreate(
  home: WorkspaceSessionState,
  request: TerminalSurfaceCreateRequest
): { result: TerminalSurfaceCreateResult; session: WorkspaceSessionState | null } {
  const { worktreeId, tabId, leafId, placement } = request
  const refuse = (reason: 'tab_not_held' | 'parent_missing') => ({
    result: { status: 'refused', reason } as const,
    session: null
  })
  const tabHeld = home.tabsByWorktree?.[worktreeId]?.some((tab) => tab.id === tabId) === true
  if (
    !tabHeld &&
    (placement.kind !== 'new-tab' ||
      hasClosedTerminalTabRecord(home.closedTerminalTabTombstonesByTabId, tabId))
  ) {
    return refuse('tab_not_held')
  }
  const root = home.terminalLayoutsByTabId?.[tabId]?.root ?? null
  if (tabHeld && (leafId === undefined || layoutContainsLeafId(root, leafId))) {
    return { result: { status: 'committed' }, session: null }
  }
  if (
    leafId !== undefined &&
    root &&
    !(placement.kind === 'split' && layoutContainsLeafId(root, placement.parentLeafId))
  ) {
    return refuse('parent_missing')
  }
  const session = cloneWorkspaceSessionState(home)
  placeTerminalPane(session, { worktreeId, tabId, leafId }, placement)
  return {
    result: { status: 'committed' },
    session: startsOrAdvancesTerminalFence(home, worktreeId, false)
      ? advanceTerminalTopologyRevision(session, worktreeId)
      : session
  }
}

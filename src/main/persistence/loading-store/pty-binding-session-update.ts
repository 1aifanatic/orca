import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { terminalPanePlacementAgreement } from '../terminal-topology/terminal-pane-placement-agreement'
import { placeTerminalPane } from '../terminal-topology/terminal-pane-placement-apply'
import { tabRowPtyIdAfterLeafBinding } from './terminal-tab-pty-ownership'
import type { PersistPtyBindingArgs } from './pty-binding-persistence'

export function applyPtyBinding(
  args: PersistPtyBindingArgs,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  paneKey: string
): void {
  // Read before any write: only a placement that names this tab's current shape is applied.
  const placement =
    terminalPanePlacementAgreement(
      args.placement,
      session,
      bindingWorktreeId,
      args.tabId,
      args.leafId
    ) === 'agrees'
      ? args.placement
      : undefined
  const reconciledIncarnation =
    args.expectedBinding !== undefined && args.incarnationId !== args.expectedBinding.incarnationId
  if (args.incarnationId) {
    session.terminalPtyIncarnationsByPaneKey = {
      ...session.terminalPtyIncarnationsByPaneKey,
      [paneKey]: args.incarnationId
    }
    if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
      session.terminalSurfaceTombstonesByPaneKey = {
        ...session.terminalSurfaceTombstonesByPaneKey
      }
      delete session.terminalSurfaceTombstonesByPaneKey[paneKey]
    }
  }
  // A spawn can beat the window's creation commit, so the binding can create its pane too.
  const terminalMembershipChanged = placeTerminalPane(
    session,
    {
      worktreeId: bindingWorktreeId,
      tabId: args.tabId,
      leafId: args.leafId,
      ...(args.startupCwd ? { startupCwd: args.startupCwd } : {})
    },
    placement
  )
  const tab = session.tabsByWorktree[bindingWorktreeId]?.find((t) => t.id === args.tabId)
  if (tab) {
    tab.ptyId = tabRowPtyIdAfterLeafBinding(
      tab,
      session.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId,
      args.leafId,
      args.ptyId
    )
  }
  if (reconciledIncarnation || terminalMembershipChanged) {
    const repoId = getRepoIdFromWorktreeId(bindingWorktreeId)
    session.terminalTopologyRevisionByRepoId = {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: (session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) + 1
    }
  }
  // Why: host-initiated persist snapshots used to omit this write-once guard, so every launch or reattach treated the worktree as never having default terminals applied.
  session.defaultTerminalTabsAppliedByWorktreeId = {
    ...session.defaultTerminalTabsAppliedByWorktreeId,
    [bindingWorktreeId]: true
  }
  // Acknowledged spawns must survive a crash before the renderer records their activity.
  if (
    session.activeWorktreeIdsOnShutdown &&
    !session.activeWorktreeIdsOnShutdown.includes(bindingWorktreeId)
  ) {
    session.activeWorktreeIdsOnShutdown = [
      ...session.activeWorktreeIdsOnShutdown,
      bindingWorktreeId
    ]
  }
  // Why: keep legacy renderer-local pane ids out of durable leaf-keyed layout state after the UUID migration.
  const layout = isTerminalLeafId(args.leafId) && session.terminalLayoutsByTabId[args.tabId]
  if (layout) {
    layout.ptyIdsByLeafId = { ...layout.ptyIdsByLeafId, [args.leafId]: args.ptyId }
  }
}

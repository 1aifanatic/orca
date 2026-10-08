import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RetiredTerminalSurface } from '../../runtime/mobile-session-terminal-retirement'

/** The caller fences the old owner; a restart keeps the pane and removes only its process binding. */
export function clearReplacedPaneBinding(
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface
): WorkspaceSessionState {
  const layout = session.terminalLayoutsByTabId[surface.parentTabId]
  if (!layout || layout.ptyIdsByLeafId?.[surface.leafId] !== surface.ptyId) {
    return session
  }
  const ptyIdsByLeafId = { ...layout.ptyIdsByLeafId }
  delete ptyIdsByLeafId[surface.leafId]
  const terminalPtyIncarnationsByPaneKey = { ...session.terminalPtyIncarnationsByPaneKey }
  delete terminalPtyIncarnationsByPaneKey[`${surface.parentTabId}:${surface.leafId}`]
  return {
    ...session,
    terminalPtyIncarnationsByPaneKey,
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [surface.parentTabId]: { ...layout, ptyIdsByLeafId }
    },
    tabsByWorktree: releaseTabRowPty(session, surface).tabsByWorktree
  }
}

/** A tab row names a live attachment; a process that is gone leaves it for the next bind to take. */
export function releaseTabRowPty(
  session: WorkspaceSessionState,
  surface: Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'ptyId'>
): WorkspaceSessionState {
  const tabs = session.tabsByWorktree[surface.worktreeId] ?? []
  if (!tabs.some((tab) => tab.id === surface.parentTabId && tab.ptyId === surface.ptyId)) {
    return session
  }
  return {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [surface.worktreeId]: tabs.map((tab) =>
        tab.id === surface.parentTabId ? { ...tab, ptyId: null } : tab
      )
    }
  }
}

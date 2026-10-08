import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { layoutContainsLeafId } from './terminal-layout-normalization'

/** The session with its normalized layouts; a pane the normalizer dropped takes its PTY incarnation. */
export function withKeptPaneIncarnations(
  session: WorkspaceSessionState,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
): WorkspaceSessionState {
  const incarnations = session.terminalPtyIncarnationsByPaneKey
  if (!incarnations) {
    return { ...session, terminalLayoutsByTabId }
  }
  const kept = Object.entries(incarnations).filter(([paneKey]) => {
    const pane = parsePaneKey(paneKey)
    const layout = pane && terminalLayoutsByTabId[pane.tabId]
    return (
      !layout ||
      layout === session.terminalLayoutsByTabId[pane.tabId] ||
      layoutContainsLeafId(layout.root, pane.leafId)
    )
  })
  return {
    ...session,
    terminalLayoutsByTabId,
    terminalPtyIncarnationsByPaneKey: Object.fromEntries(kept)
  }
}

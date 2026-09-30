import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parsePaneKey } from '../../shared/stable-pane-id'

/**
 * Session ids this worktree's saved terminal tabs are bound to, read from the workspace session
 * main already holds. A tab restored as "owner unverified" keeps this binding while nothing else
 * in main names its session, so it is the evidence a silent daemon version may still run it.
 */
export function persistedPaneSessionIdsForWorktree(
  session:
    | Pick<WorkspaceSessionState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>
    | null
    | undefined,
  worktreeId: string
): string[] {
  const ids = new Set<string>()
  for (const tab of session?.tabsByWorktree?.[worktreeId] ?? []) {
    if (tab.worktreeId !== worktreeId) {
      continue
    }
    if (typeof tab.ptyId === 'string' && tab.ptyId.length > 0) {
      ids.add(tab.ptyId)
    }
    for (const ptyId of Object.values(
      session?.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}
    )) {
      if (typeof ptyId === 'string' && ptyId.length > 0) {
        ids.add(ptyId)
      }
    }
  }
  return [...ids]
}

/** Each saved pane's session id with the incarnation the tab last recorded for it. */
export function savedIncarnationBySessionId(
  session:
    | Pick<WorkspaceSessionState, 'terminalLayoutsByTabId' | 'terminalPtyIncarnationsByPaneKey'>
    | null
    | undefined
): Map<string, string> {
  const incarnations = new Map<string, string>()
  for (const [paneKey, incarnationId] of Object.entries(
    session?.terminalPtyIncarnationsByPaneKey ?? {}
  )) {
    const parsed = parsePaneKey(paneKey)
    const ptyId = parsed
      ? session?.terminalLayoutsByTabId?.[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
      : undefined
    if (typeof ptyId === 'string' && ptyId.length > 0) {
      incarnations.set(ptyId, incarnationId)
    }
  }
  return incarnations
}

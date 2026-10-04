import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

type TabTopology = {
  owners: string[]
  ptyId: string | null | undefined
  root: unknown
  ptyIdsByLeafId: unknown
  titlesByLeafId: unknown
  remoteSessionId: string | undefined
  closedTombstone: unknown
  incarnations: Record<string, unknown>
  sleeping: Record<string, unknown>
  surfaceTombstones: Record<string, unknown>
}

const TAB_TOPOLOGY_FIELDS = [
  'owners',
  'ptyId',
  'root',
  'ptyIdsByLeafId',
  'titlesByLeafId',
  'remoteSessionId',
  'closedTombstone',
  'incarnations',
  'sleeping',
  'surfaceTombstones'
] as const satisfies readonly (keyof TabTopology)[]

function emptyTabTopology(): TabTopology {
  return {
    owners: [],
    ptyId: undefined,
    root: undefined,
    ptyIdsByLeafId: undefined,
    titlesByLeafId: undefined,
    remoteSessionId: undefined,
    closedTombstone: undefined,
    incarnations: {},
    sleeping: {},
    surfaceTombstones: {}
  }
}

/** Class (a) only (design §5.5); buffers, scrollback and presentation never count. */
export function topologyClassAChanges(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState
): string[] {
  const priorTabs = topologyByTab(prior)
  const nextTabs = topologyByTab(next)
  const changes: string[] = []
  for (const tabId of new Set([...priorTabs.keys(), ...nextTabs.keys()])) {
    const before = priorTabs.get(tabId) ?? emptyTabTopology()
    const after = nextTabs.get(tabId) ?? emptyTabTopology()
    for (const field of TAB_TOPOLOGY_FIELDS) {
      if (!isDeepStrictEqual(before[field], after[field])) {
        changes.push(`tab:${tabId}.${field}`)
      }
    }
  }
  if (
    !isDeepStrictEqual(
      prior?.terminalTopologyRevisionByRepoId ?? {},
      next.terminalTopologyRevisionByRepoId ?? {}
    )
  ) {
    changes.push('revision')
  }
  if (
    !isDeepStrictEqual(
      prior?.defaultTerminalTabsAppliedByWorktreeId ?? {},
      next.defaultTerminalTabsAppliedByWorktreeId ?? {}
    )
  ) {
    changes.push('default_applied')
  }
  return changes
}

function topologyByTab(session: WorkspaceSessionState | undefined): Map<string, TabTopology> {
  const tabs = new Map<string, TabTopology>()
  const tab = (tabId: string): TabTopology => {
    let entry = tabs.get(tabId)
    if (!entry) {
      entry = emptyTabTopology()
      tabs.set(tabId, entry)
    }
    return entry
  }
  const paneKeyed = (
    field: 'incarnations' | 'sleeping' | 'surfaceTombstones',
    record: Record<string, unknown> | undefined
  ): void => {
    for (const [paneKey, value] of Object.entries(record ?? {})) {
      const separator = paneKey.indexOf(':')
      tab(separator > 0 ? paneKey.slice(0, separator) : paneKey)[field][paneKey] = value
    }
  }
  if (!session) {
    return tabs
  }
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows ?? []) {
      const entry = tab(row.id)
      entry.owners.push(worktreeId)
      entry.ptyId = row.ptyId
    }
  }
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const entry = tab(tabId)
    entry.root = layout?.root ?? null
    entry.ptyIdsByLeafId = layout?.ptyIdsByLeafId
    entry.titlesByLeafId = layout?.titlesByLeafId
  }
  for (const [tabId, sessionId] of Object.entries(session.remoteSessionIdsByTabId ?? {})) {
    tab(tabId).remoteSessionId = sessionId
  }
  for (const [tabId, tombstone] of Object.entries(
    session.closedTerminalTabTombstonesByTabId ?? {}
  )) {
    tab(tabId).closedTombstone = tombstone
  }
  paneKeyed('incarnations', session.terminalPtyIncarnationsByPaneKey)
  paneKeyed('sleeping', session.sleepingAgentSessionsByPaneKey)
  paneKeyed('surfaceTombstones', session.terminalSurfaceTombstonesByPaneKey)
  return tabs
}

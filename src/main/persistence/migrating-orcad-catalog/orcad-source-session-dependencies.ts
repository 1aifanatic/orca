import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { sessionPartitions } from './orcad-source-workspace-session-fragments'

export type OrcadMigrationSourceSessionInspection = {
  ptyIds: Set<string>
  tabIds: Set<string>
}

type SessionScope = {
  hostId: ExecutionHostId
  ownerMatches: (ownerKey: string) => boolean
}

/** The terminal tabs and PTYs the target's sessions own, across every partition. */
export function inspectOrcadMigrationSourceSessions(
  state: PersistedState,
  scope: SessionScope
): OrcadMigrationSourceSessionInspection {
  const result: OrcadMigrationSourceSessionInspection = {
    ptyIds: new Set(),
    tabIds: new Set()
  }
  for (const [hostId, session] of sessionPartitions(state, 'local')) {
    inspectSession(session, scope, hostId === scope.hostId, result)
  }
  return result
}

function inspectSession(
  session: WorkspaceSessionState,
  scope: SessionScope,
  sourceHostPartition: boolean,
  result: OrcadMigrationSourceSessionInspection
): void {
  const matchesOwner = (ownerKey: string): boolean =>
    Boolean(ownerKey) && (sourceHostPartition || scope.ownerMatches(ownerKey))
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!matchesOwner(ownerKey)) {
      continue
    }
    for (const tab of tabs) {
      result.tabIds.add(tab.id)
      if (tab.ptyId) {
        result.ptyIds.add(tab.ptyId)
      }
    }
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (!matchesOwner(ownerKey)) {
      continue
    }
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        result.tabIds.add(tab.entityId)
      }
    }
  }
  for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    if (matchesOwner(tombstone.worktreeId)) {
      result.ptyIds.add(tombstone.ptyId)
    }
  }
}

export function orcadMigrationPaneBelongsToTabs(
  paneKey: string,
  tabIds: ReadonlySet<string>
): boolean {
  for (const tabId of tabIds) {
    if (paneKey.startsWith(`${tabId}:`)) {
      return true
    }
  }
  return false
}

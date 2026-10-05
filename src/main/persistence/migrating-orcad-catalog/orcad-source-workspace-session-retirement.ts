import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { markdownFileIdCandidates } from '../../orca-profiles/profile-session-markdown-transfer'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationOwnsRepoId,
  orcadMigrationPartitionScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { collectSessionOwnerKeys } from './orcad-source-workspace-session-fragments'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { collectOrcadMigrationSourceWorkspaceSession } from './orcad-source-workspace-session'
import { isOrcadRuntimeHostFocus } from './orcad-source-client-focus-retarget'

export function retireOrcadMigrationSourceWorkspaceSession(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  if (!manifest.payload.dormantState?.workspaceSession) {
    return
  }
  removeOrcadMigrationScopeWorkspaceSession(state, manifest)
}

/** Every partition's session state for the manifest's catalog, whether or not it could move. */
export function removeOrcadMigrationScopeWorkspaceSession(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  state.workspaceSession = removeOwnedSessionState(
    state.workspaceSession,
    orcadMigrationPartitionScope(scope, LOCAL_EXECUTION_HOST_ID)
  )
  const partitions = state.workspaceSessionsByHostId
  if (partitions) {
    state.workspaceSessionsByHostId = Object.fromEntries(
      Object.entries(partitions).map(([hostId, session]) => [
        hostId,
        session
          ? removeOwnedSessionState(session, orcadMigrationPartitionScope(scope, hostId))
          : session
      ])
    )
  }
}

/** The census lets this hint through, so retirement drops it: a restart must not dial a managed host. */
export function retireOrcadSourceReconnectHint(state: PersistedState, targetId: string): void {
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    if (!session?.activeConnectionIdsAtShutdown?.includes(targetId)) {
      continue
    }
    const remaining = session.activeConnectionIdsAtShutdown.filter((id) => id !== targetId)
    session.activeConnectionIdsAtShutdown = remaining.length > 0 ? remaining : undefined
  }
}

export function assertOrcadMigrationSourceWorkspaceSessionRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  if (!manifest.payload.dormantState?.workspaceSession) {
    return
  }
  const current = collectOrcadMigrationSourceWorkspaceSession(
    state,
    manifest.source,
    manifest.payload
  )
  if (current.payload || current.blockedCount > 0) {
    throw new Error('orcad_migration_source_workspace_session_reappeared')
  }
}

export function removeOwnedSessionState(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const ownerKeys = new Set(
    [...collectSessionOwnerKeys(session)].filter((ownerKey) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope)
    )
  )
  const removedMarkdownFileIds = new Set<string>()
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    for (const file of files) {
      markdownFileIdCandidates(file.filePath, ownerKey, file.runtimeEnvironmentId).forEach((id) =>
        removedMarkdownFileIds.add(id)
      )
    }
  }
  // Focus retargeted to the destination names the same ids on the managed host; keep it.
  const retargetedFocus = isOrcadRuntimeHostFocus(session)
    ? {
        activeRepoId: session.activeRepoId,
        activeWorktreeId: session.activeWorktreeId,
        activeWorkspaceKey: session.activeWorkspaceKey,
        activeTabId: session.activeTabId
      }
    : null
  const next = removeWorkspaceSessionOwners(session, ownerKeys) ?? session
  // Selection-only sessions and canonical workspace keys need the same scoped retirement.
  const retired = next === session ? structuredClone(session) : next
  if (retargetedFocus) {
    Object.assign(retired, retargetedFocus)
  } else {
    if (orcadMigrationOwnsRepoId(scope, retired.activeRepoId)) {
      retired.activeRepoId = null
    }
    if (orcadMigrationOwnerMatchesScope(retired.activeWorktreeId, scope)) {
      retired.activeWorktreeId = null
    }
    if (orcadMigrationOwnerMatchesScope(retired.activeWorkspaceKey, scope)) {
      retired.activeWorkspaceKey = null
    }
  }
  if (retired.activeWorkspaceExecutionHostId === scope.hostId) {
    retired.activeWorkspaceExecutionHostId = null
  }
  if (retired.markdownFrontmatterVisible) {
    retired.markdownFrontmatterVisible = Object.fromEntries(
      Object.entries(retired.markdownFrontmatterVisible).filter(
        ([fileId]) => !removedMarkdownFileIds.has(fileId)
      )
    )
  }
  for (const repoId of scope.repoIds) {
    if (!scope.sharedRepoIds.has(repoId)) {
      delete retired.terminalTopologyRevisionByRepoId?.[repoId]
    }
  }
  return retired
}

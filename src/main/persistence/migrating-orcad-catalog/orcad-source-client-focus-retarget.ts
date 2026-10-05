import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { isWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationOwnsRepoId,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/**
 * Client focus on a moved worktree follows it to the managed environment, or is cleared when the
 * destination cannot resolve it. The census never blocks on this focus, so retirement owns it.
 */
export function retargetOrcadSourceClientFocus(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const destinationHostId = manifest.destinationEnvironmentId
    ? toRuntimeExecutionHostId(manifest.destinationEnvironmentId)
    : null
  retargetSessionFocus(state.workspaceSession, scope, destinationHostId)
  for (const [hostId, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    if (session && hostId !== scope.hostId) {
      retargetSessionFocus(session, scope, destinationHostId)
    }
  }
}

/** Focus already on a runtime host names that host's workspace, never the SSH source's. */
export function isOrcadRuntimeHostFocus(session: WorkspaceSessionState): boolean {
  return parseExecutionHostId(session.activeWorkspaceExecutionHostId)?.kind === 'runtime'
}

function retargetSessionFocus(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  destinationHostId: `runtime:${string}` | null
): void {
  const owns = (value: string | null | undefined): value is string =>
    orcadMigrationOwnerMatchesScope(value, scope)
  const focusHost = session.activeWorkspaceExecutionHostId
  const aimedAtSource =
    focusHost === scope.hostId ||
    (!focusHost && (owns(session.activeWorktreeId) || owns(session.activeWorkspaceKey)))
  if (!aimedAtSource) {
    return
  }
  const worktreeId = owns(session.activeWorktreeId)
    ? unqualifyOrcadMigrationOwnerKey(session.activeWorktreeId)
    : null
  const workspaceKey = owns(session.activeWorkspaceKey)
    ? unqualifyOrcadMigrationOwnerKey(session.activeWorkspaceKey)
    : null
  if (destinationHostId && (worktreeId || workspaceKey)) {
    session.activeWorktreeId = worktreeId
    session.activeWorkspaceKey = workspaceKey && isWorkspaceKey(workspaceKey) ? workspaceKey : null
    session.activeWorkspaceExecutionHostId = destinationHostId
    return
  }
  session.activeWorktreeId = null
  session.activeWorkspaceKey = null
  session.activeWorkspaceExecutionHostId = null
  session.activeTabId = null
  if (orcadMigrationOwnsRepoId(scope, session.activeRepoId)) {
    session.activeRepoId = null
  }
}

import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { ownerKeyBelongsToRepo } from '../../orca-profiles/profile-project-worktree-identity'

export type OrcadMigrationSourceScope = {
  targetId: string
  targetGeneration: number | null
  hostId: ReturnType<typeof toSshExecutionHostId>
  repoIds: ReadonlySet<string>
  folderWorkspaceKeys: ReadonlySet<string>
  /** The session partition being read: an unqualified key there belongs to that partition's host. */
  partitionHostId?: string
}

/** The scope as seen from one session partition. */
export function orcadMigrationPartitionScope(
  scope: OrcadMigrationSourceScope,
  partitionHostId: string
): OrcadMigrationSourceScope {
  return { ...scope, partitionHostId }
}

export function createOrcadMigrationSourceScope(args: {
  source: OrcadMigrationManifestSource
  catalog: OrcadMigrationCatalogPayload
}): OrcadMigrationSourceScope {
  return {
    targetId: args.source.sshTargetId,
    targetGeneration: args.source.sshTargetGeneration,
    hostId: toSshExecutionHostId(args.source.sshTargetId),
    repoIds: new Set(args.catalog.repositories.map((repo) => repo.id)),
    folderWorkspaceKeys: new Set(
      args.catalog.folderWorkspaces.map((workspace) => `folder:${workspace.id}`)
    )
  }
}

export function orcadMigrationOwnerMatchesScope(
  value: string | null | undefined,
  scope: OrcadMigrationSourceScope
): boolean {
  if (!value) {
    return false
  }
  // Why: a repo id may repeat across hosts; only the qualifier, or the partition, says whose it is.
  const qualified = isWorktreeHostIdentity(value)
  const ownerHost = qualified
    ? getExecutionHostIdFromWorktreeHostIdentity(value)
    : scope.partitionHostId === LOCAL_EXECUTION_HOST_ID
      ? undefined
      : scope.partitionHostId
  if (ownerHost !== undefined && ownerHost !== scope.hostId) {
    return false
  }
  const rawValue = qualified ? getWorktreeIdFromHostIdentity(value) : value
  if (scope.folderWorkspaceKeys.has(rawValue)) {
    return true
  }
  for (const repoId of scope.repoIds) {
    if (ownerKeyBelongsToRepo(rawValue, repoId)) {
      return true
    }
  }
  const parsed = parseWorkspaceKey(rawValue)
  return (
    parsed?.type === 'folder' && scope.folderWorkspaceKeys.has(`folder:${parsed.folderWorkspaceId}`)
  )
}

export function unqualifyOrcadMigrationOwnerKey(value: string): string {
  return isWorktreeHostIdentity(value) ? getWorktreeIdFromHostIdentity(value) : value
}

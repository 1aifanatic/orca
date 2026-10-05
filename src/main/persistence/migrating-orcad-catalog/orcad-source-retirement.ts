/**
 * The Store's one write for a migrated target: retiring the source rows a destination proved it
 * committed. Idempotent, so a retry after a crash before the journal moved finishes the same work.
 */
import { orcadSourceFolderWorkspaceIds, repoBelongsToOrcadSource } from './orcad-source-ownership'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import {
  syncProjectHostSetupCompatibilityState,
  type RepoLifecycleOperations
} from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { retireOrcadSourceCatalogState } from './orcad-source-catalog-retirement'
import {
  assertOrcadMigrationSourceDormantStateRetired,
  retireOrcadMigrationSourceDormantState
} from './orcad-source-dormant-retirement'
import {
  retireOrcadMigrationSourceWorkspaceSession,
  retireOrcadSourceReconnectHint
} from './orcad-source-workspace-session-retirement'
import {
  collectOrcadMigrationRetirableSessionRows,
  isStaleOrcadMigrationSessionReplay,
  type OrcadMigrationSessionRows
} from './orcad-source-session-replay'
import { retargetOrcadSourceClientFocus } from './orcad-source-client-focus-retarget'
import { deleteUnreferencedOrcadMigrationScrollback } from './orcad-source-scrollback-cleanup'

const orcadSourceRetirementContext = Symbol('OrcadSourceRetirementPersistence')
type OrcadSourceRetirementRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>
type OrcadSourceRetirementContext = {
  runtime: OrcadSourceRetirementRuntime
  repos: RepoLifecycleOperations
  scheduling: WriteSchedulingOperations
}

export class OrcadSourceRetirementPersistence {
  readonly [orcadSourceRetirementContext]: OrcadSourceRetirementContext

  constructor(
    runtime: OrcadSourceRetirementRuntime,
    repos: RepoLifecycleOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[orcadSourceRetirementContext] = { runtime, repos, scheduling }
  }

  /** The caller holds a journal that proves the destination committed this exact manifest. */
  retireOrcadMigrationSourceCatalog(manifest: OrcadMigrationManifest): void {
    assertOrcadMigrationManifestDigest(manifest)
    const context = this[orcadSourceRetirementContext]
    const state = context.runtime.state
    retireOrcadSourceCatalogState(state, manifest)
    retargetOrcadSourceClientFocus(state, manifest)
    retireOrcadMigrationSourceDormantState(state, manifest)
    retireOrcadSourceReconnectHint(state, manifest.source.sshTargetId)
    syncProjectHostSetupCompatibilityState(context.repos)
    scheduleSave(context.scheduling)
  }

  /** Throws when any row the manifest moved is still, or again, on the source. */
  assertOrcadMigrationSourceRetired(manifest: OrcadMigrationManifest): void {
    const state = this[orcadSourceRetirementContext].runtime.state
    const target = manifest.source.sshTargetId
    const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
    const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
    const ownedFolderIds = orcadSourceFolderWorkspaceIds(state, target)
    if (
      state.repos.some((repo) => repoIds.has(repo.id) && repoBelongsToOrcadSource(repo, target)) ||
      [...folderIds].some((id) => ownedFolderIds.has(id))
    ) {
      throw new Error('orcad_migration_source_catalog_reappeared')
    }
    assertOrcadMigrationSourceDormantStateRetired(state, manifest)
  }

  /** The session rows this manifest's retirement would remove now, taken before it runs. */
  collectOrcadMigrationRetirableSessionRows(
    manifest: OrcadMigrationManifest
  ): OrcadMigrationSessionRows {
    return collectOrcadMigrationRetirableSessionRows(
      this[orcadSourceRetirementContext].runtime.state,
      manifest
    )
  }

  /** Removes reappeared session rows only if every one replays `retired` exactly; else keeps them. */
  retireStaleOrcadMigrationSessionReplay(
    manifest: OrcadMigrationManifest,
    retired: OrcadMigrationSessionRows
  ): boolean {
    const context = this[orcadSourceRetirementContext]
    const state = context.runtime.state
    const current = collectOrcadMigrationRetirableSessionRows(state, manifest)
    if (!isStaleOrcadMigrationSessionReplay(current, retired)) {
      return false
    }
    retireOrcadMigrationSourceWorkspaceSession(state, manifest)
    scheduleSave(context.scheduling)
    return true
  }

  /**
   * Deletes a retired manifest's scrollback files. Only after retirement is durable: until then
   * the source rows still name them. A ref any session or pending export still names is kept.
   */
  deleteRetiredOrcadMigrationScrollback(manifest: OrcadMigrationManifest): void {
    deleteUnreferencedOrcadMigrationScrollback(
      this[orcadSourceRetirementContext].runtime,
      (manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []).map(
        (snapshot) => snapshot.ref
      )
    )
  }
}

export function installOrcadSourceRetirementPersistenceContext(
  target: OrcadSourceRetirementPersistence,
  source: OrcadSourceRetirementPersistence
): void {
  Object.defineProperty(target, orcadSourceRetirementContext, {
    value: source[orcadSourceRetirementContext]
  })
}

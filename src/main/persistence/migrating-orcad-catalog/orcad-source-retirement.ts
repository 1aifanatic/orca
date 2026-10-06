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
import { assertOrcadMigrationSourceDormantStateRetired } from './orcad-source-dormant-retirement'
import {
  applyOrcadSourceRetirement,
  collectOrcadRetirementBaselines,
  collectOrcadRetirementRows,
  type OrcadRetirementRows
} from './orcad-source-retirement-baseline'
import { deleteUnreferencedOrcadMigrationScrollback } from './orcad-source-scrollback-cleanup'

export type OrcadSourceCatalogRows = Pick<
  StoreRuntimeState['state'],
  'folderWorkspaces' | 'projectGroups' | 'repos'
>

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
    applyOrcadSourceRetirement(state, manifest)
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

  /** The manifest's catalog rows still present, to put back if retirement stops on a conflict. */
  snapshotOrcadMigrationSourceCatalog(manifest: OrcadMigrationManifest): OrcadSourceCatalogRows {
    const state = this[orcadSourceRetirementContext].runtime.state
    const ids = {
      repos: new Set(manifest.payload.repositories.map((row) => row.id)),
      projectGroups: new Set(manifest.payload.projectGroups.map((row) => row.id)),
      folderWorkspaces: new Set(manifest.payload.folderWorkspaces.map((row) => row.id))
    }
    return structuredClone({
      repos: state.repos.filter((row) => ids.repos.has(row.id)),
      projectGroups: state.projectGroups.filter((row) => ids.projectGroups.has(row.id)),
      folderWorkspaces: state.folderWorkspaces.filter((row) => ids.folderWorkspaces.has(row.id))
    })
  }

  /**
   * Puts back catalog rows a stopped retirement removed: a row a user wrote since is kept, and
   * without its project it would not survive the next load.
   */
  restoreOrcadMigrationSourceCatalog(rows: OrcadSourceCatalogRows): void {
    const context = this[orcadSourceRetirementContext]
    const state = context.runtime.state
    const missing = <T extends { id: string }>(current: T[], saved: T[]): T[] => [
      ...current,
      ...saved.filter((row) => !current.some((entry) => entry.id === row.id))
    ]
    state.projectGroups = missing(state.projectGroups, rows.projectGroups)
    state.repos = missing(state.repos, rows.repos)
    state.folderWorkspaces = missing(state.folderWorkspaces, rows.folderWorkspaces)
    syncProjectHostSetupCompatibilityState(context.repos)
    scheduleSave(context.scheduling)
  }

  /** What this manifest's retirement would remove or rewrite now, as path → digests. */
  collectOrcadMigrationRetirementRows(manifest: OrcadMigrationManifest): OrcadRetirementRows {
    return collectOrcadRetirementRows(this[orcadSourceRetirementContext].runtime.state, manifest)
  }

  /** Each manifest's retirement rows, retiring them in the given order on one copy. */
  collectOrcadMigrationRetirementBaselines(
    manifests: readonly OrcadMigrationManifest[]
  ): Map<string, OrcadRetirementRows> {
    return collectOrcadRetirementBaselines(
      this[orcadSourceRetirementContext].runtime.state,
      manifests
    )
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

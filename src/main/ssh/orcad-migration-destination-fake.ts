import { vi } from 'vitest'
import type {
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'

/** An in-memory destination with the T6-9 semantics: idempotent stage, receipt-keyed commit. */
export function fakeOrcadMigrationDestination() {
  let state: 'absent' | 'staged' | 'committed' = 'absent'
  const view = (manifest: OrcadMigrationManifest): OrcadMigrationCatalogState => {
    const base = { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    if (state === 'committed') {
      return {
        ...base,
        state,
        receipt: {
          version: 1,
          migrationId: manifest.migrationId,
          manifestSha256: manifest.manifestSha256,
          source: manifest.source,
          importedAt: '2026-10-01T00:00:00.000Z',
          repositoryIds: [],
          projectGroupIds: [],
          folderWorkspaceIds: []
        }
      }
    }
    return state === 'staged'
      ? { ...base, state, stagedAt: '2026-10-01T00:00:00.000Z', snapshotUploads: [] }
      : { ...base, state }
  }
  const destination = {
    commits: 0,
    readState: vi.fn(async (manifest: OrcadMigrationManifest) => view(manifest)),
    stage: vi.fn(async (manifest: OrcadMigrationManifest) => {
      if (state === 'absent') {
        state = 'staged'
      }
      return view(manifest)
    }),
    commit: vi.fn(async (manifest: OrcadMigrationManifest) => {
      if (state === 'staged') {
        state = 'committed'
        destination.commits += 1
      }
      return view(manifest)
    }),
    abort: vi.fn(async (manifest: OrcadMigrationManifest) => {
      const aborted = state === 'staged'
      if (aborted) {
        state = 'absent'
      }
      return { ...view(manifest), aborted, ...(aborted ? {} : { durableAbsent: true as const }) }
    }),
    stageChunk: vi.fn()
  }
  return destination
}

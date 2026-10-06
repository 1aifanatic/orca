/**
 * The durable authority behind source retirement: every row it may remove, recorded in the
 * journal before anything is deleted, and checked again on every attempt. A row that changed
 * since is a user's write: the journal records a conflict, which survives reconnect and restart,
 * and the row stays until it matches the baseline again.
 */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { Store } from '../persistence'
import {
  serializeOrcadRetirementRows,
  unauthorizedOrcadRetirementRows
} from '../persistence/migrating-orcad-catalog/orcad-source-retirement-baseline'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'

const MAX_REPORTED_CONFLICTS = 32

export type OrcadRetirementAuthorityStore = Pick<
  Store,
  'collectOrcadMigrationRetirementBaselines' | 'collectOrcadMigrationRetirementRows'
>

/**
 * Records each committed cutover's baseline, newest first as retirement runs, then `marker` on
 * the chain head in the same write as its own baseline.
 */
export function recordOrcadRetirementBaselines(
  userDataPath: string,
  store: OrcadRetirementAuthorityStore,
  chain: readonly OrcadMigrationSourceCutover[],
  marker?: string
): void {
  const pending = chain.filter((cutover) => cutover.phase === 'destination-committed').toReversed()
  const baselines = store.collectOrcadMigrationRetirementBaselines(
    pending.map((cutover) => cutover.manifest)
  )
  const head = chain.at(-1)
  for (const cutover of pending) {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...cutover,
      sourceRetirementBaseline: serializeOrcadRetirementRows(
        baselines.get(cutover.migrationId) ?? new Map()
      ),
      sourceRetirementConflict: undefined,
      ...(marker && cutover.migrationId === head?.migrationId ? { sourceRetiringAt: marker } : {})
    })
  }
}

/** Throws, recording a conflict, unless every row retirement would touch now matches the baseline. */
export function authorizeOrcadRetirement(
  userDataPath: string,
  store: OrcadRetirementAuthorityStore,
  migrationId: string,
  now: () => Date
): void {
  const cutover = listOrcadMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  const baseline = cutover?.sourceRetirementBaseline
  if (!cutover || !baseline) {
    throw new Error('orcad_migration_retirement_unauthorized')
  }
  const conflicts = unauthorizedOrcadRetirementRows(
    store.collectOrcadMigrationRetirementRows(cutover.manifest),
    baseline
  )
  if (conflicts.length > 0) {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...cutover,
      sourceRetirementConflict: {
        at: now().toISOString(),
        paths: conflicts.slice(0, MAX_REPORTED_CONFLICTS)
      }
    })
    throw new Error(`orcad_migration_retirement_conflict:${conflicts.slice(0, 8).join(',')}`)
  }
  if (cutover.sourceRetirementConflict) {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...cutover,
      sourceRetirementConflict: undefined
    })
  }
}

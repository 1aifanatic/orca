/**
 * Retiring a migrated SSH target's source state, only after the journal proves the destination
 * committed it. The fenced target itself stays: it now carries the managed server's tunnel.
 *
 * Order: profile rows retired and flushed, then the journal moves to `source-retired`, then the
 * journal compacts away once the server matches it. A crash anywhere repeats idempotent work.
 */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { Store } from '../persistence'
import {
  listOrcadMigrationCutoverChainForTarget,
  listOrcadMigrationSourceCutovers,
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { environmentMatchesManagedOrcadCutover } from './orcad-managed-migration-status'
import { resolveOrcadMigrationFence } from './orcad-migration-source-fence'
import { authorizeOrcadRetirement } from './orcad-retirement-authorization'

export type OrcadMigrationRetirementStore = Pick<
  Store,
  | 'assertOrcadMigrationSourceRetired'
  | 'collectOrcadMigrationRetirementBaselines'
  | 'collectOrcadMigrationRetirementRows'
  | 'deleteRetiredOrcadMigrationScrollback'
  | 'flushPendingOrThrowAsync'
  | 'getSshRemotePtyLeases'
  | 'getSshTarget'
  | 'removeSshPtyConsumerRecovery'
  | 'removeSshRemotePtyLease'
  | 'restoreOrcadMigrationSourceCatalog'
  | 'retireOrcadMigrationSourceCatalog'
  | 'snapshotOrcadMigrationSourceCatalog'
>

export async function retireOrcadMigrationSource(
  context: {
    userDataPath: string
    store: OrcadMigrationRetirementStore
    /** The registered destination; the journal compacts only once it matches. */
    environment: KnownRuntimeEnvironment | null
    now?: () => Date
    signal?: AbortSignal
  },
  migrationId: string
): Promise<OrcadMigrationSourceCutover | null> {
  const cutover = listOrcadMigrationSourceCutovers(context.userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('orcad_migration_source_cutover_not_found')
  }
  if (cutover.phase !== 'destination-committed' && cutover.phase !== 'source-retired') {
    // Why: until the destination proves its commit, the source is the only real copy.
    throw new Error('orcad_migration_retire_before_commit')
  }
  let retired = cutover
  if (cutover.phase === 'destination-committed') {
    const target = context.store.getSshTarget(cutover.sshTargetId)
    const fence = target ? resolveOrcadMigrationFence(context.userDataPath, target) : null
    // A delta move's earlier migrations retire under the chain head's fence.
    const chain = target
      ? listOrcadMigrationCutoverChainForTarget(context.userDataPath, target.id)
      : []
    if (
      fence?.state !== 'fenced' ||
      !chain.some((entry) => entry.migrationId === cutover.migrationId)
    ) {
      throw new Error('orcad_migration_source_fence_lost')
    }
    const now = context.now ?? (() => new Date())
    // Only rows the journaled baseline names may go; anything changed since stays as a conflict.
    authorizeOrcadRetirement(context.userDataPath, context.store, migrationId, now)
    const catalog = context.store.snapshotOrcadMigrationSourceCatalog(cutover.manifest)
    await retireAndFlush(context, cutover)
    try {
      context.store.assertOrcadMigrationSourceRetired(cutover.manifest)
    } catch (error) {
      // Why: a save landing during the flush can replay moved rows. Only an exact replay of the
      // baseline is removed again; a new or changed row defers retirement and is kept.
      if (!isReappeared(error)) {
        throw error
      }
      try {
        authorizeOrcadRetirement(context.userDataPath, context.store, migrationId, now)
      } catch (conflict) {
        // The user's row stays, and so must the project it belongs to.
        context.store.restoreOrcadMigrationSourceCatalog(catalog)
        await flush(context)
        // The assertion's message names the partition the row landed in.
        throw new Error(`${errorMessage(conflict)} (${errorMessage(error)})`)
      }
      context.store.retireOrcadMigrationSourceCatalog(cutover.manifest)
      await flush(context)
      context.store.assertOrcadMigrationSourceRetired(cutover.manifest)
    }
    retired = {
      ...cutover,
      sourceRetirementConflict: undefined,
      phase: 'source-retired',
      updatedAt: (context.now ?? (() => new Date()))().toISOString()
    }
    writeOrcadMigrationSourceCutover(context.userDataPath, retired)
  }
  // After source-retired is durable; a crash before it repeats on the next retirement pass.
  context.store.deleteRetiredOrcadMigrationScrollback(retired.manifest)
  if (context.environment && environmentMatchesManagedOrcadCutover(context.environment, retired)) {
    removeOrcadMigrationSourceCutover(context.userDataPath, retired.migrationId)
    return null
  }
  return retired
}

async function retireAndFlush(
  context: { store: OrcadMigrationRetirementStore; signal?: AbortSignal },
  cutover: OrcadMigrationSourceCutover
): Promise<void> {
  context.store.retireOrcadMigrationSourceCatalog(cutover.manifest)
  retireProvenLeases(context.store, cutover)
  // The relay consumer's recovery record would only re-dial a relay this host no longer runs.
  await context.store.removeSshPtyConsumerRecovery(cutover.sshTargetId)
  await flush(context)
}

function flush(context: {
  store: OrcadMigrationRetirementStore
  signal?: AbortSignal
}): Promise<void> {
  return context.store.flushPendingOrThrowAsync({
    signal: context.signal,
    drainToStableGeneration: false
  })
}

function isReappeared(error: unknown): boolean {
  return error instanceof Error && /^orcad_migration_source_\w+_reappeared/.test(error.message)
}

/** Leases the fence proved exited name a relay that no longer serves this host. */
function retireProvenLeases(
  store: OrcadMigrationRetirementStore,
  cutover: OrcadMigrationSourceCutover
): void {
  const proven = new Set(cutover.provenPtyIds)
  for (const lease of store.getSshRemotePtyLeases(cutover.sshTargetId)) {
    if (proven.has(lease.ptyId) && (lease.state === 'terminated' || lease.state === 'expired')) {
      store.removeSshRemotePtyLease(cutover.sshTargetId, lease.ptyId)
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Catalog merges retain known rows and reject conflicting imported configuration. */
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type { Repo } from '../../../shared/repo-types'

export function selectNewRows<T extends { id: string }>(
  incoming: T[],
  existing: T[],
  conflictError: (id: string) => string,
  sameRow: (left: T, right: T) => boolean = (left, right) =>
    serializeOrcadMigrationValue(left) === serializeOrcadMigrationValue(right)
): T[] {
  const existingById = new Map(existing.map((row) => [row.id, row]))
  return incoming.filter((row) => {
    const current = existingById.get(row.id)
    if (!current) {
      return true
    }
    if (!sameRow(current, row)) {
      throw new Error(conflictError(row.id))
    }
    return false
  })
}

export function sameOrcadRepositoryConfiguration(current: Repo, incoming: Repo): boolean {
  // Git identity is the execution host's cached probe; reimport must keep that host's result.
  const { gitRemoteIdentity: _currentIdentity, ...currentConfiguration } = current
  const { gitRemoteIdentity: _incomingIdentity, ...incomingConfiguration } = incoming
  return (
    serializeOrcadMigrationValue(currentConfiguration) ===
    serializeOrcadMigrationValue(incomingConfiguration)
  )
}

export function assertSameValue(left: unknown, right: unknown, label: string): void {
  if (serializeOrcadMigrationValue(left) !== serializeOrcadMigrationValue(right)) {
    throw new Error(`orcad_migration_dormant_id_conflict:${label}`)
  }
}

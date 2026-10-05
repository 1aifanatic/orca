/**
 * What a migration's retirement removes from session state, in canonical form, so a row that
 * reappears mid-retirement can be told apart: an exact replay of moved state is safe to remove
 * again, anything new or changed is a user's write and must stay.
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  serializeOrcadMigrationValue,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { createOrcadMigrationSourceScope, orcadMigrationPartitionScope } from './orcad-source-scope'
import { sessionPartitions } from './orcad-source-workspace-session-fragments'
import { removeOwnedSessionState } from './orcad-source-workspace-session-retirement'

/** `field|key` (or `field` for a scalar) to every canonical value retirement would remove. */
export type OrcadMigrationSessionRows = Map<string, Set<string>>

export function collectOrcadMigrationRetirableSessionRows(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): OrcadMigrationSessionRows {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const rows: OrcadMigrationSessionRows = new Map()
  const add = (key: string, value: unknown): void => {
    const values = rows.get(key) ?? new Set<string>()
    values.add(serializeOrcadMigrationValue(value))
    rows.set(key, values)
  }
  for (const [hostId, session] of sessionPartitions(state, LOCAL_EXECUTION_HOST_ID)) {
    const retired = new Map<string, unknown>(
      Object.entries(removeOwnedSessionState(session, orcadMigrationPartitionScope(scope, hostId)))
    )
    for (const [field, value] of Object.entries(session)) {
      const kept = retired.get(field)
      if (serializeOrcadMigrationValue(value) === serializeOrcadMigrationValue(kept)) {
        continue
      }
      if (!isRecord(value) || !isRecord(kept ?? {})) {
        add(field, value)
        continue
      }
      const keptRecord: Record<string, unknown> = isRecord(kept) ? kept : {}
      for (const [key, entry] of Object.entries(value)) {
        if (serializeOrcadMigrationValue(entry) !== serializeOrcadMigrationValue(keptRecord[key])) {
          add(`${field}|${key}`, entry)
        }
      }
    }
  }
  return rows
}

/**
 * True when every row retirement would now remove is byte-identical to one it already removed
 * (in any partition): a stale copy of moved state, never a user's new or changed write.
 */
export function isStaleOrcadMigrationSessionReplay(
  current: OrcadMigrationSessionRows,
  retired: OrcadMigrationSessionRows
): boolean {
  return (
    current.size > 0 &&
    [...current].every(([key, values]) =>
      [...values].every((value) => retired.get(key)?.has(value) ?? false)
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

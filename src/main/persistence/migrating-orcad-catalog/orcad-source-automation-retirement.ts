import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'

/** The manifest's automations, and any a downgraded build added to a moved project since. */
export function retireOrcadMigrationSourceAutomationState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
  const automationIds = new Set([
    ...(manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id),
    ...state.automations
      .filter((entry) => repoIds.has(getAutomationRunRepoId(entry)))
      .map((entry) => entry.id)
  ])
  const runIds = new Set((manifest.payload.dormantState?.automationRuns ?? []).map((run) => run.id))
  state.automations = state.automations.filter((entry) => !automationIds.has(entry.id))
  state.automationRuns = state.automationRuns.filter(
    (run) => !runIds.has(run.id) && !automationIds.has(run.automationId)
  )
}

export function assertOrcadMigrationSourceAutomationStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const automationIds = new Set(
    (manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id)
  )
  const runIds = new Set(
    (manifest.payload.dormantState?.automationRuns ?? []).map((entry) => entry.id)
  )
  if (
    state.automations.some((entry) => automationIds.has(entry.id)) ||
    state.automationRuns.some((entry) => runIds.has(entry.id))
  ) {
    throw new Error('orcad_migration_source_automation_state_reappeared')
  }
}

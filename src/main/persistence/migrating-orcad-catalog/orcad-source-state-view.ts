/**
 * What a converted host's retained source holds that a user wrote, read straight from the profile
 * rather than from what a move could carry: a session a move refuses (a disagreement between
 * partitions, a tab kind no move carries) still holds drafts an older build may have edited, and
 * leaving them out would let their edit read as unchanged and be retired.
 *
 * Null when any session cannot be read, or worktree metadata claims the source host but cannot be
 * attributed: the retained source is then unverified, never "unchanged".
 */
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'
import { sessionPartitions } from './orcad-source-workspace-session-fragments'
import { automationTouchesScope } from './orcad-source-automation-state'
import { inspectOrcadSourceWorktreeMetadata } from './orcad-source-worktree-metadata'

export type OrcadSourceStateView = {
  drafts: unknown[]
  automations: unknown[]
  worktrees: unknown[]
}

export function collectOrcadSourceStateView(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload
): OrcadSourceStateView | null {
  try {
    const scope = createOrcadMigrationSourceScope({ source, catalog, repos: state.repos })
    const drafts: unknown[] = []
    for (const [hostId, session] of sessionPartitions(state, LOCAL_EXECUTION_HOST_ID)) {
      const partition = orcadMigrationPartitionScope(scope, hostId)
      for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
        if (hostId !== scope.hostId && !orcadMigrationOwnerMatchesScope(ownerKey, partition)) {
          continue
        }
        if (!Array.isArray(files)) {
          return null
        }
        for (const file of files) {
          if (file.dirtyDraftContent !== undefined) {
            drafts.push([
              unqualifyOrcadMigrationOwnerKey(ownerKey),
              file.filePath,
              file.dirtyDraftContent
            ])
          }
        }
      }
    }
    // Why the move's predicate: a repo id another host shares is not this host's to fingerprint.
    const automations = state.automations
      .filter((automation) => automationTouchesScope(automation, scope))
      .map((automation) => [
        automation.id,
        automation.name,
        automation.prompt,
        automation.precheck,
        automation.agentId,
        automation.workspaceMode,
        automation.workspaceId,
        automation.baseBranch,
        automation.timezone,
        automation.rrule,
        automation.dtstart,
        automation.enabled,
        automation.reuseSession,
        automation.missedRunPolicy
      ])
    // Why export's attribution: retirement deletes what it owns, so the view must see every
    // representation it owns too; metadata it cannot attribute leaves the source unverified.
    const metadata = inspectOrcadSourceWorktreeMetadata(state, scope)
    if (metadata.blockedCount > 0) {
      return null
    }
    const worktrees = metadata.rows.map(({ sourceKey, meta }) => [
      unqualifyOrcadMigrationOwnerKey(sourceKey),
      meta.displayName,
      meta.comment
    ])
    return { drafts, automations, worktrees }
  } catch (error) {
    console.warn('[migration] Unreadable retained source state; it stays unverified:', error)
    return null
  }
}

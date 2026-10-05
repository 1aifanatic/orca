/**
 * The substantive state a converted host's retained source still holds, fingerprinted so a later
 * start can tell whether an older build changed it: unsaved editor drafts, the user-authored names
 * and settings of its catalog rows, the workspace names and comments a move carries, and its
 * automations (name, prompt, schedule, enabled, target workspace).
 *
 * The fields are listed here rather than hashed from the whole projection, so a field a later
 * build adds, or metadata this build resolves in the background, never reads as a user's change.
 * Focus, timestamps, unread marks and list order are left out on purpose. The version prefix lets
 * a later build that changes this list read an older fingerprint as unverified, never as changed.
 */
import { createHash } from 'node:crypto'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'

export type OrcadSourceStateStore = Pick<
  Store,
  'inspectOrcadMigrationSourceState' | 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'
>

// v2: worktree metadata and automations use the move's attribution (identity-backed rows,
// hostId-attributed keys, repo ids another host shares).
export const ORCAD_SOURCE_STATE_FINGERPRINT_VERSION = 'v2'

/**
 * The whole retained source as it is now, so a delta's baseline covers every row still kept. Null
 * when a session cannot be read: nothing proves the source unchanged, so it is never retired.
 */
export function currentOrcadSourceStateFingerprint(
  store: OrcadSourceStateStore,
  target: Pick<SshTarget, 'id' | 'generation' | 'label'>
): string | null {
  const catalog = collectOrcadMigrationSourceCatalog(store, target)
  const view = store.inspectOrcadMigrationSourceState(
    {
      sshTargetId: target.id,
      sshTargetGeneration: target.generation ?? null,
      targetLabel: target.label
    },
    catalog
  )
  if (!view) {
    return null
  }
  const substantive = {
    repositories: catalog.repositories.map((repo) => [
      repo.id,
      repo.path,
      repo.displayName,
      repo.badgeColor,
      repo.repoIcon,
      repo.kind,
      repo.gitUsername,
      repo.worktreeBaseRef,
      repo.worktreeBasePath,
      repo.hookSettings,
      repo.issueSourcePreference,
      repo.ghAccount,
      repo.forkSyncMode
    ]),
    folderWorkspaces: catalog.folderWorkspaces.map((folder) => [
      folder.id,
      folder.projectGroupId,
      folder.name,
      folder.folderPath,
      folder.comment,
      folder.linkedTask,
      folder.isArchived,
      folder.isPinned
    ]),
    projectGroups: catalog.projectGroups.map((group) => [
      group.id,
      group.name,
      group.parentPath,
      group.parentGroupId,
      group.color
    ]),
    ...view
  }
  // Sorted: a build that only reorders rows or partitions has changed nothing a user wrote.
  const ordered = Object.fromEntries(
    Object.entries(substantive).map(([key, rows]) => [
      key,
      rows.map((row) => serializeOrcadMigrationValue(row)).sort()
    ])
  )
  const digest = createHash('sha256').update(serializeOrcadMigrationValue(ordered)).digest('hex')
  return `${ORCAD_SOURCE_STATE_FINGERPRINT_VERSION}:${digest}`
}

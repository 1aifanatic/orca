import { getRepoSshConnectionId } from '../../shared/execution-host'
import { isGitRepoKind } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { isFirstPartyWorktreeContentOrigin } from '../../shared/worktree/content-origin'
import { hasCurrentOrcaCreationProvenance } from '../worktree-removal-safety'
import { isFolderWorkspaceIdForRepo } from '../ipc/worktrees/folder-workspace-model'

export type ClaudeWorktreeTrustTarget = {
  worktreeId: string
  worktreeRoot: string
  mainCheckoutPath: string
  /** SSH connection that runs Claude for this worktree; null means this machine. */
  connectionId: string | null
  /** Desired state: true grants, false revokes the entry Orca wrote. */
  trusted: boolean
}

type ClaudeWorktreeTrustStore = {
  getRepo: (repoId: string) => Repo | undefined
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getSettings: () => Pick<GlobalSettings, 'claudeTrustOrcaWorktrees'>
}

/**
 * Only worktrees Orca created in a git repo are Orca's to trust or revoke. The user's
 * own folders, external checkouts and main checkouts return null and are never touched.
 */
export function resolveClaudeWorktreeTrustTarget(
  store: ClaudeWorktreeTrustStore,
  worktreeId: string | undefined
): ClaudeWorktreeTrustTarget | null {
  if (!worktreeId) {
    return null
  }
  const parsed = splitWorktreeId(worktreeId)
  const repo = parsed ? store.getRepo(parsed.repoId) : undefined
  if (!parsed || !repo || !isGitRepoKind(repo) || isFolderWorkspaceIdForRepo(repo, worktreeId)) {
    return null
  }
  const meta = store.getWorktreeMeta(worktreeId)
  if (!hasCurrentOrcaCreationProvenance(meta)) {
    return null
  }
  return {
    worktreeId,
    worktreeRoot: parsed.worktreePath,
    mainCheckoutPath: repo.path,
    connectionId: getRepoSshConnectionId(repo),
    trusted:
      store.getSettings().claudeTrustOrcaWorktrees !== false &&
      isFirstPartyWorktreeContentOrigin(meta?.orcaCreationContentOrigin)
  }
}

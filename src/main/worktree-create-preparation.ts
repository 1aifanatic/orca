// Starts a spare checkout when the create composer has refreshed its base on an idle machine. The
// only caller is the composer prefetch (IPC `worktrees:prefetchCreateBase`, RPC
// `worktree.prefetchCreateBase`); nothing re-arms one after a create (rule 3).
import type { Store } from './persistence'
import type { Repo } from '../shared/repo-types'
import { isFolderRepo } from '../shared/repo-kind'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'
import { checkSparePostCheckoutHook } from './git/worktree-create-preparation'
import { resolveWorktreeBaseCommitOid } from './git/worktree-base-ref-probe'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'
import { computeWorkspaceRootAsync, getWorktreePathSettings } from './ipc/worktree-logic'
import {
  getLocalProjectWorktreeGitOptions,
  getWorktreeMirrorDistro
} from './project-runtime-git-options'
import {
  abandonRepoSpare,
  findSpare,
  isSpareQuitting,
  noteSpareHookUnsupported,
  preparationPathKey,
  spareRepoKey,
  startSpare,
  worktreePreparationGit
} from './worktree-create-preparation-pool'
import {
  mayAbandonSpareForBaseChange,
  recordSpareAbandonedForBaseChange,
  spareStartRefusal
} from './worktree-create-spare-gate'

/** Only the last base picked in a quiet stretch builds, so flipping through bases costs nothing. */
export const SPARE_REQUEST_DEBOUNCE_MS = 2_000

const pendingRequests = new Map<string, ReturnType<typeof setTimeout>>()

/** Synchronous and fire-and-forget: the composer never waits on a spare. */
export function requestWorktreeCreateSpare(store: Store, repo: Repo, baseBranch: string): void {
  if (repo.connectionId || isFolderRepo(repo) || isSpareQuitting()) {
    return
  }
  let options: GitWorktreeExecOptions
  try {
    options = getLocalProjectWorktreeGitOptions(store, repo)
  } catch {
    // A project runtime awaiting repair runs no Git.
    return
  }
  const repoKey = spareRepoKey(repo.path, options.wslDistro)
  clearTimeout(pendingRequests.get(repoKey))
  const timer = setTimeout(() => {
    pendingRequests.delete(repoKey)
    void worktreePreparationGit
      .run(() => startRequestedSpare(store, repo, baseBranch, options, repoKey))
      .catch((error: unknown) => {
        console.warn(`[worktree-create] could not start a spare checkout for ${repo.path}`, error)
      })
  }, SPARE_REQUEST_DEBOUNCE_MS)
  timer.unref?.()
  pendingRequests.set(repoKey, timer)
}

async function resolveSpareCommit(
  repoPath: string,
  baseBranch: string,
  options: GitWorktreeExecOptions
): Promise<string | null> {
  // The create's own resolvers, so the spare lands on exactly the commit a plain add would use.
  let oid: string | null = null
  const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, async (qualifiedRef) => {
    oid = await resolveWorktreeBaseCommitOid(repoPath, qualifiedRef, options)
    return oid !== null
  })
  // A fully qualified ref or a commit id is passed through unprobed.
  return oid ?? (await resolveWorktreeBaseCommitOid(repoPath, effectiveBase, options))
}

async function startRequestedSpare(
  store: Store,
  repo: Repo,
  baseBranch: string,
  options: GitWorktreeExecOptions,
  repoKey: string
): Promise<void> {
  // The gate comes before anything is abandoned: a refused request keeps the existing spare.
  if (spareStartRefusal()) {
    return
  }
  const workspaceRoot = await computeWorkspaceRootAsync(
    repo.path,
    getWorktreePathSettings(repo, store.getSettings(), getWorktreeMirrorDistro(store, repo))
  )
  const oid = await resolveSpareCommit(repo.path, baseBranch, options)
  if (!oid) {
    return
  }
  const existing = findSpare(repoKey)
  const sameSpare =
    existing?.oid === oid && existing.workspaceRootKey === preparationPathKey(workspaceRoot)
  if (sameSpare || (existing && !mayAbandonSpareForBaseChange(repoKey))) {
    return
  }
  const hook = await checkSparePostCheckoutHook(repo.path, options)
  if (!hook.honorable) {
    noteSpareHookUnsupported(repoKey)
    return
  }
  // Re-checked after the awaits: a create may have started, or another request replaced the spare.
  if (spareStartRefusal() || isSpareQuitting() || findSpare(repoKey) !== existing) {
    return
  }
  if (existing) {
    recordSpareAbandonedForBaseChange(repoKey)
    abandonRepoSpare(repoKey)
  }
  startSpare({ repoPath: repo.path, workspaceRoot, oid, hookRun: hook.hookRun, options })
}

export function _resetSpareRequestsForTests(): void {
  for (const timer of pendingRequests.values()) {
    clearTimeout(timer)
  }
  pendingRequests.clear()
}

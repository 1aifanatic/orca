// Why this exists: Orca used to build a spare checkout under `<workspace root>/.orca-preparing`
// while the create composer was open. That feature is gone, so every spare an older build left on
// disk — registered with Git and locked, or an orphaned directory — has to be reclaimed once.

import { lstat, readdir, readFile, rmdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  isWorktreeCreatePreparation,
  parseWorktreePreparationOwnerPid,
  parseWorktreePreparationPathOwnerPid,
  WORKTREE_CREATE_PREPARATION_DIRECTORY
} from '../shared/worktree/create-preparation'
import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import { windowsLongPathGitArgs } from '../shared/windows-long-path-git-args'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'
import {
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from './git/worktree-operation-options'
import { listWorktreeGraph } from './git/worktree-listing'
import { gitExecFileAsync } from './git/runner'
import { runWithGitReadCacheInvalidation } from './git/status'
import { bumpWorktreeScanGeneration } from './git/worktree-scan-cache'
import { invalidateWslLinkedWorktreeGitRouting } from './git/wsl-linked-worktree-git-routing'
import { whenLocalWorktreeCreatesSettle } from './git/local-worktree-create-activity'
import { removeHostTree } from './host-tree-removal'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import type { Store } from './persistence'
import { getLocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { parseWslPath } from './wsl'

// `<pid>-<uuid v4>`, as the retired pool named them.
const PREPARATION_ENTRY_PATTERN =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type RetiredPreparationSweepTarget = {
  repo: Repo
  workspaceRoot: string
  gitOptions: GitWorktreeExecOptions
}

export type RetiredPreparationSweepDeps = {
  isProcessAlive?: (pid: number) => boolean
}

function isProcessAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means alive but not ours to signal; only ESRCH proves the owner is gone.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function reclaimOptions(repoPath: string, options: GitWorktreeExecOptions) {
  return {
    ...gitExecOptions(repoPath, { ...options, admissionTier: 'background' as const }),
    timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
}

async function runPreparationGit(
  repoPath: string,
  worktreePath: string,
  args: string[],
  options: GitWorktreeExecOptions
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(
        [...windowsLongPathGitArgs(repoPath), 'worktree', ...args, worktreePath],
        reclaimOptions(repoPath, options)
      )
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
    bumpWorktreeScanGeneration(repoPath)
  }
}

/** Reclaims one repo's locked spares whose owning Orca process is gone; returns how many. */
async function sweepRegisteredPreparations(
  target: RetiredPreparationSweepTarget,
  isProcessAlive: (pid: number) => boolean
): Promise<number> {
  const { repo, gitOptions } = target
  let reclaimed = 0
  const worktrees = await listWorktreeGraph(repo.path, {
    ...gitOptions,
    admissionTier: 'background',
    includeCreatePreparations: true
  })
  for (const worktree of worktrees.filter(isWorktreeCreatePreparation)) {
    const lockOwnerPid = parseWorktreePreparationOwnerPid(worktree.lockReason)
    // A live owner is an older Orca still running; it owns its spare until it exits.
    if (!lockOwnerPid || isProcessAlive(lockOwnerPid)) {
      continue
    }
    await whenLocalWorktreeCreatesSettle()
    const pathOwnerPid = parseWorktreePreparationPathOwnerPid(worktree.path)
    try {
      if (worktree.branch && pathOwnerPid === null) {
        // A crash after the spare was moved to the user's path left a real worktree: keep it, drop
        // only the lock that hides it.
        await runPreparationGit(repo.path, worktree.path, ['unlock'], gitOptions)
      } else if (pathOwnerPid === lockOwnerPid) {
        // Git 2.25 removes a locked worktree with the doubled --force.
        await runPreparationGit(
          repo.path,
          worktree.path,
          ['remove', '--force', '--force'],
          gitOptions
        )
      } else {
        continue
      }
      reclaimed += 1
    } catch (error) {
      console.warn(`[worktrees] Could not reclaim retired spare checkout ${worktree.path}`, error)
    }
  }
  return reclaimed
}

/** True when the directory's `.git` pointer still names an existing admin entry. */
async function isStillRegistered(entryPath: string): Promise<boolean> {
  let pointer: string
  try {
    pointer = await readFile(join(entryPath, '.git'), 'utf-8')
  } catch {
    return false
  }
  const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim()
  if (!gitDir) {
    return false
  }
  try {
    await lstat(isAbsolute(gitDir) ? gitDir : resolve(entryPath, gitDir))
    return true
  } catch {
    return false
  }
}

/** Deletes unregistered spare directories whose owning process is gone; returns how many. */
async function sweepOrphanedPreparationDirectories(
  workspaceRoot: string,
  isProcessAlive: (pid: number) => boolean
): Promise<number> {
  if (parseWslPath(workspaceRoot)) {
    return 0
  }
  const preparationRoot = join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
  let entries: string[]
  try {
    const rootStat = await lstat(preparationRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return 0
    }
    entries = await readdir(preparationRoot)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!PREPARATION_ENTRY_PATTERN.test(entry)) {
      continue
    }
    const ownerPid = Number(entry.split('-')[0])
    const entryPath = join(preparationRoot, entry)
    if (isProcessAlive(ownerPid) || (await isStillRegistered(entryPath))) {
      continue
    }
    await whenLocalWorktreeCreatesSettle()
    try {
      await removeHostTree(entryPath)
      removed += 1
    } catch (error) {
      console.warn(`[worktrees] Could not delete retired spare checkout ${entryPath}`, error)
    }
  }
  // Only succeeds once empty, so a live older Orca's spare keeps the folder.
  await rmdir(preparationRoot).catch(() => {})
  return removed
}

/**
 * Background, one repo at a time: registrations first so Git forgets a spare before its directory
 * goes, then any directory Git no longer knows about. Never throws.
 */
export async function sweepRetiredWorktreeCreatePreparations(
  targets: readonly RetiredPreparationSweepTarget[],
  deps: RetiredPreparationSweepDeps = {}
): Promise<{ reclaimed: number; removedDirectories: number }> {
  const isProcessAlive = deps.isProcessAlive ?? isProcessAliveDefault
  let reclaimed = 0
  let removedDirectories = 0
  const workspaceRoots = new Set<string>()
  for (const target of targets) {
    if (target.repo.connectionId || isFolderRepo(target.repo)) {
      continue
    }
    workspaceRoots.add(target.workspaceRoot)
    try {
      reclaimed += await sweepRegisteredPreparations(target, isProcessAlive)
    } catch (error) {
      console.warn(`[worktrees] Could not list ${target.repo.path} for retired spares`, error)
    }
  }
  for (const workspaceRoot of workspaceRoots) {
    removedDirectories += await sweepOrphanedPreparationDirectories(workspaceRoot, isProcessAlive)
  }
  if (reclaimed + removedDirectories > 0) {
    console.log(
      `[worktrees] Reclaimed ${reclaimed} retired spare checkout registration(s) and ${removedDirectories} director(ies)`
    )
  }
  return { reclaimed, removedDirectories }
}

export function collectRetiredPreparationSweepTargets(
  store: Store
): RetiredPreparationSweepTarget[] {
  const settings = store.getSettings()
  const targets: RetiredPreparationSweepTarget[] = []
  for (const repo of store.getRepos()) {
    if (repo.connectionId || isFolderRepo(repo)) {
      continue
    }
    try {
      targets.push({
        repo,
        workspaceRoot: computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings)),
        gitOptions: getLocalProjectWorktreeGitOptions(store, repo)
      })
    } catch {
      // A repo with an unusable configured base path never had a spare to reclaim.
    }
  }
  return targets
}

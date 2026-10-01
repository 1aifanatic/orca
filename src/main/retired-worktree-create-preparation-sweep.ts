// Why this exists: Orca used to build a spare checkout under `<workspace root>/.orca-preparing`
// while the create composer was open. That feature is gone, so the spares an older build left on
// disk — locked registrations, never-checked-out checkouts, orphaned directories — are reclaimed.
// An unlocked spare that was checked out was listed in the sidebar and may be the user's work now,
// so, like anything else the sweep cannot prove is Orca's, it stays for the user to remove.
//
// Why read Git's files instead of listing worktrees: the on-disk records work on every Git version
// (the listing's lock reason needs 2.31+), and a kept entry costs only file reads per launch, save
// a never-checked-out spare holding added files, which Git re-checks each time.

import { lstat, mkdtemp, readdir, readFile, realpath, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  parseWorktreePreparationOwnerPid,
  parseWorktreePreparationPathOwnerPid,
  WORKTREE_CREATE_PREPARATION_DIRECTORY
} from '../shared/worktree/create-preparation'
import { isFolderRepo } from '../shared/repo-kind'
import { windowsLongPathGitArgs } from '../shared/windows-long-path-git-args'
import { WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from './git/worktree-operation-options'
import { gitExecFileAsync } from './git/runner'
import { runWithGitReadCacheInvalidation } from './git/status'
import { bumpWorktreeScanGeneration } from './git/worktree-scan-cache'
import { invalidateWslLinkedWorktreeGitRouting } from './git/wsl-linked-worktree-git-routing'
import { whenLocalWorktreeCreatesSettle } from './git/local-worktree-create-activity'
import { removeHostTree } from './host-tree-removal'
import { isWorktreeRemovalPendingAt } from './worktree-background-removal'
import { computeWorkspaceRoot, getWorktreePathSettings } from './ipc/worktree-logic'
import type { Store } from './persistence'
import {
  getLocalProjectWorktreeGitOptions,
  type LocalProjectWorktreeGitOptions
} from './project-runtime-git-options'
import { parseWslPath } from './wsl'

// `<pid>-<uuid v4>`, as the retired pool named them.
const PREPARATION_ENTRY_PATTERN =
  /^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type RetiredPreparationSweepRepo = LocalProjectWorktreeGitOptions & { path: string }

export type RetiredPreparationSweepTargets = {
  /** Folders whose `.orca-preparing` may hold spares of any repo, including ones Orca dropped. */
  workspaceRoots: readonly string[]
  /** Local repos whose registrations may carry a spare's lock outside those folders. */
  repos: readonly RetiredPreparationSweepRepo[]
}

/** Where a repo's `git worktree` commands run: through its own routing when Orca knows it. */
type WorktreeGitHost = { cwd: string; args: string[]; wslDistro?: string; repoPath?: string }

export type RetiredPreparationSweepDeps = {
  isProcessAlive?: (pid: number) => boolean
}

type SweepResult = { reclaimed: number; removedDirectories: number }

function isProcessAliveDefault(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means alive but not ours to signal; only ESRCH proves the owner is gone.
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

/** Null for a path that does not exist; any other failure throws, so the caller keeps the entry. */
async function nullWhenMissing<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function readTrimmedFile(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, 'utf-8')).trim()
  } catch {
    return undefined
  }
}

/** The Git directory a checkout's `.git` file names, whether or not it still exists. */
async function readGitDirPointer(checkoutPath: string): Promise<string | null> {
  const pointer = await nullWhenMissing(readFile(join(checkoutPath, '.git'), 'utf-8'))
  const gitDir = pointer && /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim()
  return gitDir ? resolve(checkoutPath, gitDir) : null
}

async function findCommonDirOfGitDir(gitDir: string): Promise<string> {
  const commonDir = await readTrimmedFile(join(gitDir, 'commondir'))
  return commonDir ? resolve(gitDir, commonDir) : gitDir
}

async function findRepoCommonDir(repoPath: string): Promise<string | null> {
  const dotGit = join(repoPath, '.git')
  const dotGitStat = await lstat(dotGit).catch(() => null)
  if (dotGitStat?.isDirectory()) {
    return dotGit
  }
  // A `.git` file makes the repo itself a linked checkout; no `.git` at all, a bare repo.
  const gitDir = dotGitStat ? await readGitDirPointer(repoPath) : repoPath
  return gitDir ? findCommonDirOfGitDir(gitDir) : null
}

function runBackgroundGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; wslDistro?: string } = {}
): Promise<{ stdout: string }> {
  return gitExecFileAsync([...windowsLongPathGitArgs(cwd), ...args], {
    cwd,
    admissionTier: 'background',
    timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
    ...options
  })
}

async function runWorktreeCommand(
  host: WorktreeGitHost,
  worktreePath: string,
  args: string[]
): Promise<void> {
  await whenLocalWorktreeCreatesSettle()
  try {
    await runWithGitReadCacheInvalidation(() =>
      runBackgroundGit(host.cwd, [...host.args, 'worktree', ...args, worktreePath], {
        wslDistro: host.wslDistro
      })
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
    if (host.repoPath) {
      bumpWorktreeScanGeneration(host.repoPath)
    }
  }
}

/** True when every file in the checkout is HEAD's own: a spare whose checkout never finished. */
async function holdsOnlyHeadContent(checkoutPath: string): Promise<boolean> {
  await whenLocalWorktreeCreatesSettle()
  // A scratch index, so the check never writes the checkout's own index.
  const scratch = await mkdtemp(join(tmpdir(), 'orca-retired-spare-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') }
  try {
    await runBackgroundGit(checkoutPath, ['read-tree', 'HEAD'], { env })
    // Flags, not the user's config, decide what is listed: every untracked and ignored file too.
    const { stdout } = await runBackgroundGit(
      checkoutPath,
      ['status', '--porcelain', '--untracked-files=all', '--ignored', '--ignore-submodules=none'],
      { env }
    )
    // Files the checkout never wrote read as deleted; anything else is content someone added.
    return stdout.split('\n').every((line) => line === '' || line.startsWith(' D '))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Reclaims one dead owner's spare directory; returns what it reclaimed, if anything. */
async function reclaimSpareDirectory(
  sparePath: string,
  ownerPid: number,
  hostByCommonDir: ReadonlyMap<string, WorktreeGitHost>
): Promise<keyof SweepResult | null> {
  // A user's delete owns the path (Git records it resolved); never follow a symlink out of the folder.
  const resolvedPath = await realpath(sparePath).catch(() => sparePath)
  const owned = isWorktreeRemovalPendingAt(sparePath) || isWorktreeRemovalPendingAt(resolvedPath)
  if (owned || !(await lstat(sparePath)).isDirectory()) {
    return null
  }
  const hasDotGit = (await nullWhenMissing(lstat(join(sparePath, '.git')))) !== null
  const adminDir = hasDotGit ? await readGitDirPointer(sparePath) : null
  if (!adminDir || !(await nullWhenMissing(lstat(adminDir)))) {
    // Git does not know it. With no `.git` it was never registered, or an older build's delete got
    // past it; a checkout Git pruned (its path moved, then any prune) may hold user work, so it stays.
    if (hasDotGit) {
      return null
    }
    await whenLocalWorktreeCreatesSettle()
    await removeHostTree(sparePath)
    return 'removedDirectories'
  }
  const commonDir = await findCommonDirOfGitDir(adminDir)
  // A repo no longer in Orca is reached through its Git directory.
  const host = hostByCommonDir.get(commonDir) ?? {
    cwd: commonDir,
    args: [`--git-dir=${commonDir}`]
  }
  const lockReason = await readTrimmedFile(join(adminDir, 'locked'))
  if (lockReason !== undefined) {
    // Any other lock is the user's, or another process's spare.
    if (parseWorktreePreparationOwnerPid(lockReason) !== ownerPid) {
      return null
    }
    // Git 2.25 removes a locked worktree with the doubled --force.
    await runWorktreeCommand(host, sparePath, ['remove', '--force', '--force'])
    return 'reclaimed'
  }
  // Older builds locked a spare only after its checkout, so an unlocked one with an index was
  // listed in the sidebar and may be the user's worktree now (commits on its detached HEAD, ignored
  // files): never touched. Only a checkout that never finished, holding only HEAD's files, is Orca's.
  const hasIndex = (await nullWhenMissing(lstat(join(adminDir, 'index')))) !== null
  if (hasIndex || !(await holdsOnlyHeadContent(sparePath))) {
    return null
  }
  await runWorktreeCommand(host, sparePath, ['remove', '--force'])
  return 'reclaimed'
}

async function sweepPreparationFolder(
  workspaceRoot: string,
  isOwnerRunning: (pid: number) => boolean,
  hostByCommonDir: ReadonlyMap<string, WorktreeGitHost>,
  result: SweepResult
): Promise<void> {
  const preparationRoot = join(workspaceRoot, WORKTREE_CREATE_PREPARATION_DIRECTORY)
  let entries: string[]
  try {
    // lstat: a symlinked folder is not ours to walk.
    if (!(await lstat(preparationRoot)).isDirectory()) {
      return
    }
    entries = await readdir(preparationRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    const ownerPid = Number(entry.split('-')[0])
    if (!PREPARATION_ENTRY_PATTERN.test(entry) || isOwnerRunning(ownerPid)) {
      continue
    }
    const sparePath = join(preparationRoot, entry)
    try {
      const reclaimed = await reclaimSpareDirectory(sparePath, ownerPid, hostByCommonDir)
      if (reclaimed) {
        result[reclaimed] += 1
      }
    } catch (error) {
      console.warn(`[worktrees] Could not reclaim retired spare checkout ${sparePath}`, error)
    }
  }
  // Only succeeds once empty, so a live older Orca's spare (or a user's file) keeps the folder.
  await rmdir(preparationRoot).catch(() => {})
}

/** Reclaims dead owners' locks the folders cannot reach; returns how many. */
async function sweepLockedRegistrations(
  commonDir: string,
  host: WorktreeGitHost,
  isOwnerRunning: (pid: number) => boolean
): Promise<number> {
  const adminRoot = join(commonDir, 'worktrees')
  let adminNames: string[]
  try {
    adminNames = await readdir(adminRoot)
  } catch {
    return 0
  }
  let reclaimed = 0
  for (const adminName of adminNames) {
    const adminDir = join(adminRoot, adminName)
    const lockOwnerPid = parseWorktreePreparationOwnerPid(
      await readTrimmedFile(join(adminDir, 'locked'))
    )
    if (!lockOwnerPid || isOwnerRunning(lockOwnerPid)) {
      continue
    }
    const gitFile = await readTrimmedFile(join(adminDir, 'gitdir'))
    if (!gitFile) {
      continue
    }
    // Kept as Git wrote it: a WSL repo's Git recorded a Linux path that only it can resolve.
    const worktreePath = dirname(isAbsolute(gitFile) ? gitFile : resolve(adminDir, gitFile))
    const pathOwnerPid = parseWorktreePreparationPathOwnerPid(worktreePath)
    try {
      if (pathOwnerPid === null) {
        // A crash after the spare was moved to the user's path left their worktree: drop only the
        // lock that hides it (unlock never deletes).
        await runWorktreeCommand(host, worktreePath, ['unlock'])
      } else if (pathOwnerPid === lockOwnerPid) {
        // The spare's directory is gone, or sits in a folder no longer configured.
        await runWorktreeCommand(host, worktreePath, ['remove', '--force', '--force'])
      } else {
        continue
      }
      reclaimed += 1
    } catch (error) {
      console.warn(`[worktrees] Could not reclaim retired spare checkout ${worktreePath}`, error)
    }
  }
  return reclaimed
}

/**
 * Background and one item at a time: spare folders first (they reach every repo's spares), then
 * the locks they cannot reach. Every Git spawn and deletion waits for local creates to settle, so
 * none starts during a create that began mid-sweep. Never throws.
 */
export async function sweepRetiredWorktreeCreatePreparations(
  targets: RetiredPreparationSweepTargets,
  deps: RetiredPreparationSweepDeps = {}
): Promise<SweepResult> {
  const isProcessAlive = deps.isProcessAlive ?? isProcessAliveDefault
  // This build never creates spares, so one naming this process is an older Orca's reused pid.
  const isOwnerRunning = (pid: number): boolean => pid !== process.pid && isProcessAlive(pid)
  const hostByCommonDir = new Map<string, WorktreeGitHost>()
  for (const repo of targets.repos) {
    const commonDir = await findRepoCommonDir(repo.path).catch(() => null)
    if (commonDir) {
      const host = { cwd: repo.path, args: [], wslDistro: repo.wslDistro, repoPath: repo.path }
      hostByCommonDir.set(commonDir, host)
    }
  }
  const result: SweepResult = { reclaimed: 0, removedDirectories: 0 }
  for (const workspaceRoot of new Set(targets.workspaceRoots)) {
    await sweepPreparationFolder(workspaceRoot, isOwnerRunning, hostByCommonDir, result)
  }
  for (const [commonDir, host] of hostByCommonDir) {
    result.reclaimed += await sweepLockedRegistrations(commonDir, host, isOwnerRunning)
  }
  if (result.reclaimed + result.removedDirectories > 0) {
    console.log(
      `[worktrees] Reclaimed ${result.reclaimed} retired spare checkout registration(s) and ${result.removedDirectories} director(ies)`
    )
  }
  return result
}

/**
 * Local repos only. A WSL repo's spare folder is skipped: resolving its root can block the main
 * thread on `wsl.exe`, and its Git recorded Linux paths this process cannot follow. Its locked
 * spares are still reclaimed through its registrations, by its own Git.
 */
export function collectRetiredPreparationSweepTargets(
  store: Store
): RetiredPreparationSweepTargets {
  const settings = store.getSettings()
  const workspaceRoots = new Set<string>()
  const repos: RetiredPreparationSweepRepo[] = []
  for (const repo of store.getRepos()) {
    if (repo.connectionId || isFolderRepo(repo)) {
      continue
    }
    let gitOptions: LocalProjectWorktreeGitOptions
    try {
      gitOptions = getLocalProjectWorktreeGitOptions(store, repo)
    } catch {
      // A project runtime awaiting repair runs no Git.
      continue
    }
    repos.push({ path: repo.path, ...gitOptions })
    if (parseWslPath(repo.path) || gitOptions.wslDistro) {
      continue
    }
    try {
      const workspaceRoot = computeWorkspaceRoot(repo.path, getWorktreePathSettings(repo, settings))
      if (!parseWslPath(workspaceRoot)) {
        workspaceRoots.add(workspaceRoot)
      }
    } catch {
      // A repo with an unusable configured base path never had a spare folder there.
    }
  }
  return { workspaceRoots: [...workspaceRoots], repos }
}

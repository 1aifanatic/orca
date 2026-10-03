import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { waitForPromiseWithSignal } from './abort-signal-reason'
import {
  isMissingGitAdminEntry,
  readGitAdminFile,
  resolveGitCommonDirectory,
  type GitAdminReadOptions
} from './git-common-directory'
import { resolveGitMetadataPath, resolveWorktreeHostPath } from './git-metadata-path'
import { mapWithConcurrency } from './map-with-concurrency'
import { foldWslUncPathCaseInsensitiveParts } from './wsl-paths'
import type { GitWorktreeInfo } from './worktree/types'

const ADMIN_READ_CONCURRENCY = 8
type WorktreeAdminDirectory = { gitDir: string; worktreePath?: string; isMain?: true }

function hostPathKey(value: string): string {
  const normalized = path.resolve(value)
  return (
    foldWslUncPathCaseInsensitiveParts(normalized) ??
    (process.platform === 'win32' ? normalized.toLowerCase() : normalized)
  )
}

async function readWorktreeAdminDirectories(
  repoPath: string,
  options: GitAdminReadOptions
): Promise<WorktreeAdminDirectory[]> {
  const commonDir = await resolveGitCommonDirectory(repoPath, options)
  if (!commonDir) {
    throw new Error('Cannot read Git worktree administrative directory.')
  }
  const adminDir = path.join(commonDir, 'worktrees')
  let entries: Dirent[]
  try {
    entries = await waitForPromiseWithSignal(
      readdir(adminDir, { withFileTypes: true }),
      options.signal
    )
  } catch (error) {
    if (isMissingGitAdminEntry(error)) {
      return [{ gitDir: commonDir, isMain: true }]
    }
    throw error
  }
  const linked = await mapWithConcurrency(
    entries.filter((entry) => entry.isDirectory()),
    ADMIN_READ_CONCURRENCY,
    async (entry): Promise<WorktreeAdminDirectory> => {
      const gitDir = path.join(adminDir, entry.name)
      const gitdir = await readGitAdminFile(path.join(gitDir, 'gitdir'), options.signal)
      const target = gitdir && resolveGitMetadataPath(gitDir, gitdir, options)
      return { gitDir, ...(target ? { worktreePath: path.dirname(target) } : {}) }
    }
  )
  return [{ gitDir: commonDir, isMain: true }, ...linked]
}

/** Older porcelain omits locks; the marker remains the authoritative ownership proof. */
export async function annotateWorktreeLocksFromAdmin(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitAdminReadOptions = {}
): Promise<GitWorktreeInfo[]> {
  if (!worktrees.some((worktree) => !worktree.isMainWorktree && !worktree.locked)) {
    return worktrees
  }
  const directories = await readWorktreeAdminDirectories(repoPath, options)
  const locks = new Map<string, string>()
  await mapWithConcurrency(directories, ADMIN_READ_CONCURRENCY, async (entry) => {
    if (!entry.worktreePath) {
      return
    }
    const reason = await readGitAdminFile(path.join(entry.gitDir, 'locked'), options.signal)
    if (reason !== null) {
      locks.set(hostPathKey(entry.worktreePath), reason.trim())
    }
  })
  options.signal?.throwIfAborted()
  return worktrees.map((worktree) => {
    const hostPath = resolveWorktreeHostPath(worktree.path, options)
    const reason = hostPath ? locks.get(hostPathKey(hostPath)) : undefined
    return reason === undefined
      ? worktree
      : { ...worktree, locked: true, ...(reason ? { lockReason: reason } : {}) }
  })
}

function updateRefsReserveBranch(contents: string | null, branchName: string): boolean {
  if (!contents) {
    return false
  }
  const lines = contents.split(/\r?\n/)
  if (lines.at(-1) === '') {
    lines.pop()
  }
  if (lines.length % 3 !== 0) {
    throw new Error('Cannot verify rebase update-refs branch usage.')
  }
  let reserved = false
  for (let i = 0; i < lines.length; i += 3) {
    const ref = lines[i]
    const before = lines[i + 1] ?? ''
    const after = lines[i + 2] ?? ''
    if (
      !ref ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(before) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(after) ||
      before.length !== after.length
    ) {
      throw new Error('Cannot verify rebase update-refs branch usage.')
    }
    reserved ||= ref === `refs/heads/${branchName}`
  }
  return reserved
}

/** Rebase and bisect reserve branches even when HEAD no longer points to them. */
export async function isBranchReservedByWorktreeOperation(
  repoPath: string,
  branchName: string,
  worktrees: GitWorktreeInfo[],
  options: GitAdminReadOptions = {}
): Promise<boolean> {
  const nonBare = worktrees.filter((worktree) => !worktree.isBare)
  if (nonBare.length === 0) {
    return false
  }
  const targets = new Set(
    nonBare.map((worktree) => {
      const hostPath = resolveWorktreeHostPath(worktree.path, options)
      return hostPath ? hostPathKey(hostPath) : worktree.path
    })
  )
  const directories = await readWorktreeAdminDirectories(repoPath, options)
  const relevant = directories.filter((entry) =>
    entry.isMain
      ? nonBare.some((worktree) => worktree.isMainWorktree)
      : entry.worktreePath && targets.has(hostPathKey(entry.worktreePath))
  )
  if (relevant.length < nonBare.length) {
    throw new Error('Cannot verify worktree branch usage.')
  }
  const matches = await mapWithConcurrency(relevant, ADMIN_READ_CONCURRENCY, async (entry) => {
    const [rebaseMerge, rebaseApply, bisect, updateRefs] = await Promise.all(
      [
        'rebase-merge/head-name',
        'rebase-apply/head-name',
        'BISECT_START',
        'rebase-merge/update-refs'
      ].map((name) => readGitAdminFile(path.join(entry.gitDir, ...name.split('/')), options.signal))
    )
    const reserved = updateRefsReserveBranch(updateRefs, branchName)
    return (
      reserved ||
      [rebaseMerge, rebaseApply, bisect].some(
        (marker) => marker?.trim().replace(/^refs\/heads\//, '') === branchName
      )
    )
  })
  options.signal?.throwIfAborted()
  return matches.some(Boolean)
}

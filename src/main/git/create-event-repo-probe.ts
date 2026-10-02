import { open, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { getErrorCode } from './worktree-operation-options'

/** Existence only: the hook's content is never read. */
export type PostCheckoutHookPresence = 'present' | 'absent' | 'custom_hooks_path' | 'unknown'

/** What the create event says about the repo, read from its `.git` directory. */
export type CreateEventRepoFacts = {
  postCheckoutHook: PostCheckoutHookPresence
  /** Entries in the index header, i.e. tracked files; absent when the count is missing or unreliable. */
  indexEntryCount?: number
  /** The main checkout plus every registered linked worktree, prepared checkouts included. */
  worktreeCount?: number
}

const PROBE_TIMEOUT_MS = 2_000

/**
 * Reads, from files only and never by spawning Git, whether `git worktree add` in this repo will
 * run a repo-local post-checkout hook, and how many files the repo tracks.
 *
 * A `core.hooksPath` in the repo's config is reported as such rather than followed, and global or
 * included config is not read, so a hooks path set there reads as `absent`. A `.git` file (a repo
 * registered from a linked worktree or submodule) needs Git to resolve, so it yields neither fact.
 */
export async function probeCreateEventRepoFacts(
  repoPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<CreateEventRepoFacts> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<CreateEventRepoFacts>((resolve) => {
    // A hung network or WSL mount must not hold the caller; this answer is best-effort.
    timer = setTimeout(() => resolve({ postCheckoutHook: 'unknown' }), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([readFacts(repoPath, platform), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function readFacts(
  repoPath: string,
  platform: NodeJS.Platform
): Promise<CreateEventRepoFacts> {
  const gitDir = path.join(repoPath, '.git')
  const isGitDirectory = await stat(gitDir).then(
    (entry) => entry.isDirectory(),
    () => false
  )
  if (!isGitDirectory) {
    return { postCheckoutHook: 'unknown' }
  }
  // `git sparse-checkout --sparse-index` and per-worktree settings write to config.worktree.
  const [mainConfig, worktreeConfig] = await Promise.all([
    readFile(path.join(gitDir, 'config'), 'utf8').catch(() => null),
    readFile(path.join(gitDir, 'config.worktree'), 'utf8').catch(() => '')
  ])
  const config = mainConfig === null ? null : `${mainConfig}\n${worktreeConfig}`
  const [postCheckoutHook, indexEntryCount, worktreeCount] = await Promise.all([
    readPostCheckoutHook(gitDir, config, platform),
    readIndexEntryCount(gitDir, config),
    readWorktreeCount(gitDir)
  ])
  return {
    postCheckoutHook,
    ...(indexEntryCount !== undefined ? { indexEntryCount } : {}),
    ...(worktreeCount !== undefined ? { worktreeCount } : {})
  }
}

/** One listing of `.git/worktrees`, Git's registry of linked worktrees, since the create itself no
 *  longer lists them. Admin directory names survive `worktree move`, so prepared checkouts cannot be
 *  told apart here; the caller subtracts the ones it holds. */
async function readWorktreeCount(gitDir: string): Promise<number | undefined> {
  try {
    const entries = await readdir(path.join(gitDir, 'worktrees'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).length + 1
  } catch (error) {
    return getErrorCode(error) === 'ENOENT' ? 1 : undefined
  }
}

/** `core.sparseCheckout` or `index.sparse` set to anything Git reads as true, bare key included. */
const SPARSE_CHECKOUT_ON = /^\s*sparse(checkout)?\s*(=(?!\s*(false|no|off|0)\s*$).*)?$/im

/**
 * The entry count from the index header (`DIRC`, version, big-endian count), which is the same in
 * every index version. A split index keeps entries elsewhere and a sparse index collapses them into
 * directories, so with either possible (any sparse checkout) the count is left out.
 */
async function readIndexEntryCount(
  gitDir: string,
  config: string | null
): Promise<number | undefined> {
  if (config === null || SPARSE_CHECKOUT_ON.test(config)) {
    return undefined
  }
  try {
    const entries = await readdir(gitDir)
    if (entries.some((name) => name.startsWith('sharedindex.'))) {
      return undefined
    }
    const index = await open(path.join(gitDir, 'index'), 'r')
    try {
      const header = Buffer.alloc(12)
      const { bytesRead } = await index.read(header, 0, 12, 0)
      if (bytesRead < 12 || header.toString('latin1', 0, 4) !== 'DIRC') {
        return undefined
      }
      return header.readUInt32BE(8)
    } finally {
      await index.close()
    }
  } catch {
    return undefined
  }
}

async function readPostCheckoutHook(
  gitDir: string,
  config: string | null,
  platform: NodeJS.Platform
): Promise<PostCheckoutHookPresence> {
  if (config === null) {
    return 'unknown'
  }
  try {
    if (/^\s*hookspath\s*=/im.test(config)) {
      return 'custom_hooks_path'
    }
    const hook = await stat(path.join(gitDir, 'hooks', 'post-checkout')).catch((error) => {
      if (getErrorCode(error) === 'ENOENT') {
        return null
      }
      throw error
    })
    if (!hook || !hook.isFile()) {
      return 'absent'
    }
    // Git skips a hook without an execute bit, except on Windows where it has none to check.
    return platform === 'win32' || (hook.mode & 0o111) !== 0 ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}

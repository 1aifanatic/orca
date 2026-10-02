import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getErrorCode } from './worktree-operation-options'

/** Existence only: the hook's content is never read. */
export type PostCheckoutHookPresence = 'present' | 'absent' | 'custom_hooks_path' | 'unknown'

/** What the create event says about the repo, read from its `.git` directory. */
export type CreateEventRepoFacts = {
  postCheckoutHook: PostCheckoutHookPresence
  /** Byte size of `.git/index`; absent when there is none or it could not be read. */
  indexBytes?: number
}

const PROBE_TIMEOUT_MS = 2_000

/**
 * Reads, from files only and never by spawning Git, whether `git worktree add` in this repo will
 * run a repo-local post-checkout hook, and how large the repo's index is.
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
  const [postCheckoutHook, indexBytes] = await Promise.all([
    readPostCheckoutHook(gitDir, platform),
    stat(path.join(gitDir, 'index')).then(
      (index) => (index.isFile() ? index.size : undefined),
      () => undefined
    )
  ])
  return { postCheckoutHook, ...(indexBytes !== undefined ? { indexBytes } : {}) }
}

async function readPostCheckoutHook(
  gitDir: string,
  platform: NodeJS.Platform
): Promise<PostCheckoutHookPresence> {
  try {
    const config = await readFile(path.join(gitDir, 'config'), 'utf8')
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

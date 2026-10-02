import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getErrorCode } from './worktree-operation-options'

/** Existence only: the hook's content is never read. */
export type PostCheckoutHookPresence = 'present' | 'absent' | 'custom_hooks_path' | 'unknown'

const PROBE_TIMEOUT_MS = 2_000

/**
 * Whether `git worktree add` in this repo will run a repo-local post-checkout hook.
 *
 * Reads files only, never spawns Git. A `core.hooksPath` in the repo's config is reported as
 * such rather than followed, and global or included config is not read, so a hooks path set
 * there reads as `absent`.
 */
export async function probePostCheckoutHookPresence(
  repoPath: string,
  platform: NodeJS.Platform = process.platform
): Promise<PostCheckoutHookPresence> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PostCheckoutHookPresence>((resolve) => {
    // A hung network or WSL mount must not hold the caller; this answer is best-effort.
    timer = setTimeout(() => resolve('unknown'), PROBE_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([readPresence(repoPath, platform), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function readPresence(
  repoPath: string,
  platform: NodeJS.Platform
): Promise<PostCheckoutHookPresence> {
  try {
    const gitDir = path.join(repoPath, '.git')
    // A `.git` file (a repo registered from a linked worktree or submodule) needs Git to resolve.
    if (!(await stat(gitDir)).isDirectory()) {
      return 'unknown'
    }
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

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The ratchet behind "every removal asks the review host about a kept branch": removal code reaches
 * the push-target remote cleanup only through settleKeptBranch / settleKeptSshBranch, so a removal
 * path cannot keep a squash-merged branch without asking, or drop a fork remote before the delete.
 */
const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..')
const MAIN_DIRECTORY = join(REPOSITORY_ROOT, 'src', 'main')
const PUSH_TARGET_CLEANUP = /\bcleanupUnusedWorktreePushTargetRemote\w*\b/

/** Only ever shrinks. */
const ALLOWED_CALLERS = new Map<string, string>([
  ['src/main/ipc/worktree-push-target-cleanup.ts', 'defines the cleanup'],
  ['src/main/ipc/worktree-remote.ts', 'defines the local and SSH entry points'],
  ['src/main/source-control/forge-merged-branch-cleanup.ts', 'the settle itself'],
  // The "Delete branch" toast action deletes after the fact; it is not a removal path.
  ['src/main/ipc/worktrees/removal/register-worktree-forget-handlers.ts', 'Delete branch (IPC)'],
  ['src/main/runtime/runtime-preserved-branch-cleanup.ts', 'Delete branch (runtime)']
])

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(path)
    }
    const isSource = /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
    return isSource ? [path] : []
  })
}

describe('kept-branch settlement route', () => {
  it('lets only the settle and the Delete branch actions call the push-target cleanup', () => {
    const callers = listSourceFiles(MAIN_DIRECTORY)
      .filter((path) => PUSH_TARGET_CLEANUP.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPOSITORY_ROOT, path).split('\\').join('/'))
      .sort()

    expect(callers.filter((path) => !ALLOWED_CALLERS.has(path))).toEqual([])
    // Drop an entry once its file stops calling the cleanup.
    expect([...ALLOWED_CALLERS.keys()].filter((path) => !callers.includes(path))).toEqual([])
  })
})

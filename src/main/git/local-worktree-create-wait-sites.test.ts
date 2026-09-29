import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why a ratchet: waiting for creates to settle is only safe at a background producer's entry.
// Inside a request/response path (a renderer IPC handler, a runtime RPC, a paired client, the
// CLI) it would park a caller for up to the deadline. A new call site must be a producer that
// nothing awaits; request paths answer from cache instead.
const ALLOWED_WAIT_SITES = new Set([
  'src/main/git/local-worktree-create-activity.ts',
  'src/main/ipc/worktree-base-directory-notifications.ts',
  'src/main/github/pr-refresh-queue-drainer.ts',
  'src/main/worktree-trash.ts',
  'src/main/retired-worktree-create-preparation-sweep.ts'
])

const WAIT_PRIMITIVES = /\b(whenLocalWorktreeCreatesSettle|createLocalWorktreeCreateDeferral)\b/

const REPO_ROOT = join(__dirname, '..', '..', '..')

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

describe('local worktree create wait sites', () => {
  it('only background producers wait for local creates to settle', () => {
    const callers = ['src/main', 'src/shared', 'src/relay']
      .flatMap((dir) => sourceFiles(join(REPO_ROOT, dir)))
      .filter((file) => WAIT_PRIMITIVES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))

    expect(callers.filter((file) => !ALLOWED_WAIT_SITES.has(file))).toEqual([])
    // Keep the allow-list honest: a site that stopped waiting should leave it.
    expect([...ALLOWED_WAIT_SITES].filter((file) => !callers.includes(file))).toEqual([])
  })
})

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { Repo } from '../../shared/repo-types'
import { getErrorCode } from '../git/worktree-operation-options'
import { resolveLocalProjectRuntimesForRepos } from '../local-project-runtime-resolution'
import type { Store } from '../persistence'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../project-runtime-git-options'
import { listRepoWorktreeGraph } from '../repo-worktrees'

const CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS = 1_000
const AUTHORIZED_ROOTS_REBUILD_CONCURRENCY = 8

/** `wslDistro` names the Git that listed the roots; undefined is host Git. */
type ListedRoots = { roots: Set<string>; listingFailed: boolean; wslDistro: string | undefined }

/**
 * The WSL distro whose Git lists each repo's worktrees, or undefined for host Git.
 *
 * Why the project runtime: the catalog and removal list through it, and WSL Git records a `C:\`
 * worktree as `/mnt/c/...`. Host Git reading that metadata names another path, so the roots would
 * never match the path every other consumer sends. A runtime awaiting repair keeps host Git, which
 * this listing always used, so a repair prompt never revokes file access.
 */
export function resolveWorktreeRootListingDistros(
  store: Store,
  repos: readonly Repo[]
): Map<string, string | undefined> {
  const runtimes = resolveLocalProjectRuntimesForRepos(store, repos)
  return new Map(
    repos.map((repo) => {
      const runtime = runtimes.get(repo.id)
      return [
        repo.id,
        runtime?.status === 'resolved'
          ? getLocalProjectWorktreeGitOptionsForRuntime(repo, runtime).wslDistro
          : undefined
      ]
    })
  )
}

/** Owners whose roots came from a Git other than the one their project runtime now selects. */
export function findOwnersListedThroughAnotherGit<
  Owner extends { listed: unknown; listedWslDistro: string | undefined }
>(store: Store, repos: ReadonlyMap<string, Repo>, owners: ReadonlyMap<string, Owner>): Owner[] {
  const distros = resolveWorktreeRootListingDistros(store, [...repos.values()])
  return [...repos].flatMap(([key, repo]) => {
    const owner = owners.get(key)
    return owner?.listed && owner.listedWslDistro !== distros.get(repo.id) ? [owner] : []
  })
}

export async function listWorktreeRootsWithConcurrency(
  store: Store,
  repos: readonly Repo[]
): Promise<ListedRoots[]> {
  const distros = resolveWorktreeRootListingDistros(store, repos)
  const results: ListedRoots[] = []
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(AUTHORIZED_ROOTS_REBUILD_CONCURRENCY, repos.length) },
      async () => {
        while (nextIndex < repos.length) {
          const index = nextIndex++
          const repo = repos[index]
          const wslDistro = distros.get(repo.id)
          const roots = new Set([resolve(repo.path)])
          let listingFailed = false
          try {
            for (const worktree of await listRepoWorktreeGraph(
              repo,
              wslDistro ? { wslDistro } : {}
            )) {
              roots.add(resolve(worktree.path))
            }
          } catch (error) {
            console.warn(
              `[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`,
              error
            )
            listingFailed = true
          }
          results[index] = { roots, listingFailed, wslDistro }
        }
      }
    )
  )
  return results
}

/** An unavailable mount is not evidence that a recovered worktree disappeared. */
export async function pruneCreatedWorktreeRoots(
  recoveredRoots: ReadonlySet<string>,
  listed: ListedRoots
): Promise<Set<string>> {
  const recovered = new Set(recoveredRoots)
  if (!listed.listingFailed) {
    await Promise.all(
      [...recovered].map(async (root) => {
        if (listed.roots.has(root) || (await isRootGoneFromDisk(root))) {
          recovered.delete(root)
        }
      })
    )
  }
  return recovered
}

async function isRootGoneFromDisk(targetPath: string): Promise<boolean> {
  const probe = stat(targetPath).then(
    () => false,
    (error: unknown) => getErrorCode(error) === 'ENOENT'
  )
  return withTimeout(probe, CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS, false)
}

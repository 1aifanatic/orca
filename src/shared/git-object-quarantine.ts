import { mkdtemp, readdir, rename, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import { removeTree } from './windows-transient-lock-removal'

/**
 * Runs a Git command whose object writes are throwaway (`merge-tree --write-tree`
 * only wants its stdout) against a scratch object directory, so nothing it
 * writes lands in the repository's real object store as unreachable loose
 * objects. Reads still see every real object through the alternates variable.
 */

export type GitObjectQuarantineEnv = {
  GIT_OBJECT_DIRECTORY: string
  GIT_ALTERNATE_OBJECT_DIRECTORIES: string
}

export type GitObjectsDirectory = {
  /** How this process spells `objects/` when creating and deleting the scratch dir. */
  hostPath: string
  /** How the Git child spells the same directory (differs for WSL). */
  gitPath: string
}

export type GitObjectQuarantine = {
  run: <T>(command: (env: GitObjectQuarantineEnv | undefined) => Promise<T>) => Promise<T>
}

// Why inside `objects/` with a `tmp_objdir` prefix: that is where Git puts its own
// quarantine dirs, it is on the Git host for native, WSL and SSH alike, and
// `git gc` expires stale `tmp_*` entries too.
export const GIT_OBJECT_QUARANTINE_DIR_PREFIX = 'tmp_objdir-orca-merge-tree-'

// Why an hour: a run lives at most as long as a Git read (minutes), so anything older was
// stranded by a crash or a failed delete, including repos where `git gc` never runs.
export const STALE_GIT_OBJECT_QUARANTINE_AGE_MS = 60 * 60 * 1000

const sweptObjectsDirectories = new Set<string>()

/** Decided by path syntax, not by platform: a Windows main process drives WSL Git. */
export function pathApiForGitPath(value: string): typeof posix {
  return isWindowsAbsolutePathLike(value) ? win32 : posix
}

// Why: Git splits this variable on `:` (`;` for Git for Windows) and C-unquotes a leading `"`.
function alternateObjectDirectoriesValue(gitPath: string): string {
  const needsQuoting = isWindowsAbsolutePathLike(gitPath) ? /[;"]/ : /[:"\\]/
  if (!needsQuoting.test(gitPath)) {
    return gitPath
  }
  return `"${gitPath.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

async function sweepStaleScratchDirectories(objectsHostPath: string): Promise<void> {
  if (sweptObjectsDirectories.has(objectsHostPath)) {
    return
  }
  sweptObjectsDirectories.add(objectsHostPath)
  const path = pathApiForGitPath(objectsHostPath)
  const entries = await readdir(objectsHostPath).catch(() => [])
  const cutoff = Date.now() - STALE_GIT_OBJECT_QUARANTINE_AGE_MS
  for (const entry of entries) {
    if (!entry.startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX)) {
      continue
    }
    const scratch = path.join(objectsHostPath, entry)
    const modified = await stat(scratch).then(
      (stats) => stats.mtimeMs,
      () => undefined
    )
    if (modified !== undefined && modified < cutoff) {
      await removeTree(scratch).catch(() => {})
    }
  }
}

/**
 * A partial clone fetches missing blobs on demand, and Git files that download
 * as a pack in the scratch dir. Keep those packs so the next check does not
 * download the same blobs again; merge-tree's own writes are loose objects.
 */
async function keepFetchedPacks(scratchHostPath: string, objectsHostPath: string): Promise<void> {
  const path = pathApiForGitPath(objectsHostPath)
  const scratchPackDir = path.join(scratchHostPath, 'pack')
  const entries = await readdir(scratchPackDir).catch(() => [])
  const packNames = entries
    .filter((entry) => /^pack-[0-9a-f]+\.pack$/.test(entry))
    .map((entry) => entry.slice(0, -'.pack'.length))
  for (const packName of packNames) {
    const files = entries.filter((entry) => entry.startsWith(`${packName}.`))
    if (!files.includes(`${packName}.idx`)) {
      continue
    }
    // Why `.idx` last: Git finds a pack through its index, so everything it names must already be in place.
    const ordered = [...files.filter((file) => !file.endsWith('.idx')), `${packName}.idx`]
    try {
      for (const file of ordered) {
        await rename(path.join(scratchPackDir, file), path.join(objectsHostPath, 'pack', file))
      }
    } catch (error) {
      // Why: a pack without its index is invisible to Git; the next lookup fetches it again.
      console.warn('[git-object-quarantine] could not keep a fetched pack', packName, error)
    }
  }
}

/** Resolves the objects dir once per quarantine; each run gets its own scratch dir. */
export function createGitObjectQuarantine(
  resolveObjectsDirectory: () => Promise<GitObjectsDirectory | undefined>
): GitObjectQuarantine {
  let objectsDirectory: Promise<GitObjectsDirectory | undefined> | undefined
  const resolveOnce = (): Promise<GitObjectsDirectory | undefined> => {
    objectsDirectory ??= resolveObjectsDirectory().catch(() => undefined)
    return objectsDirectory
  }

  return {
    async run(command) {
      const objects = await resolveOnce()
      let scratchHostPath: string | undefined
      if (objects) {
        await sweepStaleScratchDirectories(objects.hostPath)
        const path = pathApiForGitPath(objects.hostPath)
        scratchHostPath = await mkdtemp(
          path.join(objects.hostPath, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
        ).catch(() => undefined)
      }
      if (!objects || !scratchHostPath) {
        // Why: bookkeeping must not block the user's action; run unquarantined.
        return command(undefined)
      }
      try {
        return await command({
          GIT_OBJECT_DIRECTORY: pathApiForGitPath(objects.gitPath).join(
            objects.gitPath,
            pathApiForGitPath(scratchHostPath).basename(scratchHostPath)
          ),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjectDirectoriesValue(objects.gitPath)
        })
      } finally {
        await keepFetchedPacks(scratchHostPath, objects.hostPath)
        await removeTree(scratchHostPath).catch((error: unknown) => {
          // Why: the stale sweep removes it on a later run; the check's result still stands.
          console.warn(
            '[git-object-quarantine] could not remove scratch dir',
            scratchHostPath,
            error
          )
        })
      }
    }
  }
}

export function _resetGitObjectQuarantineSweepForTests(): void {
  sweptObjectsDirectories.clear()
}

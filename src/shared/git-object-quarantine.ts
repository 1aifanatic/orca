import { lstat, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
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
  /** GIT_ALTERNATE_OBJECT_DIRECTORIES as Git would inherit it unquarantined. */
  inheritedAlternates?: string
}

export type GitObjectQuarantine = {
  run: <T>(command: (env: GitObjectQuarantineEnv | undefined) => Promise<T>) => Promise<T>
}

// Why inside `objects/` with a `tmp_objdir` prefix: that is where Git puts its own
// quarantine dirs, it is on the Git host for native, WSL and SSH alike, and
// `git gc` expires stale `tmp_*` entries too.
export const GIT_OBJECT_QUARANTINE_DIR_PREFIX = 'tmp_objdir-orca-merge-tree-'

// Why two weeks: `git gc` expires its own `objects/tmp_*` dirs at that age, and no merge-tree runs that long.
export const STALE_GIT_OBJECT_QUARANTINE_AGE_MS = 14 * 24 * 60 * 60 * 1000

const sweepsByObjectsDirectory = new Map<string, Promise<void>>()

/** Decided by path syntax, not by platform: a Windows main process drives WSL Git. */
export function pathApiForGitPath(value: string): typeof posix {
  return isWindowsAbsolutePathLike(value) ? win32 : posix
}

// Why: Git splits this variable on `:` (`;` for Git for Windows) and C-unquotes a leading `"`.
function quoteAlternate(path: string, windowsGit: boolean): string {
  const needsQuoting = windowsGit ? /[;"]/ : /[:"\\]/
  if (!needsQuoting.test(path)) {
    return path
  }
  return `"${path.replace(/[\\"]/g, (char) => `\\${char}`)}"`
}

/**
 * Which inherited object-store variables a quarantine can mirror, as `GitObjectsDirectory` fields;
 * undefined when it cannot: an inherited GIT_OBJECT_DIRECTORY is the store Git reads and writes.
 */
export function inheritedObjectStore(
  env: Record<string, string | undefined>
): Pick<GitObjectsDirectory, 'inheritedAlternates'> | undefined {
  if (env.GIT_OBJECT_DIRECTORY !== undefined) {
    return undefined
  }
  const alternates = env.GIT_ALTERNATE_OBJECT_DIRECTORIES
  return alternates ? { inheritedAlternates: alternates } : {}
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/**
 * The alternates for a quarantined run, or undefined to run unquarantined. Inherited value first,
 * as Git's own temporary object dirs append. A real store with its own alternates is not
 * quarantined: as an alternate instead of the primary, its chain would link one level deeper.
 */
async function quarantineAlternates(objects: GitObjectsDirectory): Promise<string | undefined> {
  const alternatesFile = pathApiForGitPath(objects.hostPath).join(
    objects.hostPath,
    'info',
    'alternates'
  )
  const hasAlternatesFile = await stat(alternatesFile).then(
    () => true,
    (error: unknown) => !isMissingFileError(error)
  )
  if (hasAlternatesFile) {
    return undefined
  }
  const windowsGit = isWindowsAbsolutePathLike(objects.gitPath)
  const realStore = quoteAlternate(objects.gitPath, windowsGit)
  return objects.inheritedAlternates
    ? `${objects.inheritedAlternates}${windowsGit ? ';' : ':'}${realStore}`
    : realStore
}

async function sweepStaleScratchDirectories(objectsHostPath: string): Promise<void> {
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

// Why not awaited: cleanup must not delay the user's check, and it only removes dirs far older than this run's.
function startSweepOnce(objectsHostPath: string): void {
  if (!sweepsByObjectsDirectory.has(objectsHostPath)) {
    sweepsByObjectsDirectory.set(
      objectsHostPath,
      sweepStaleScratchDirectories(objectsHostPath).catch(() => {})
    )
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
    // Why no `.keep`: an aborted lazy fetch can leave its transient one, and gc never repacks a kept pack.
    const kept = files.filter((file) => !file.endsWith('.keep'))
    // Why `.idx` last: Git finds a pack through its index, so everything it names must already be in place.
    const ordered = [...kept.filter((file) => !file.endsWith('.idx')), `${packName}.idx`]
    const installed: string[] = []
    try {
      for (const file of ordered) {
        const target = path.join(objectsHostPath, 'pack', file)
        // Why skip: pack names are content hashes, and replacing a live pack's file could strand its index.
        const exists = await lstat(target).then(
          () => true,
          () => false
        )
        if (exists) {
          continue
        }
        await rename(path.join(scratchPackDir, file), target)
        installed.push(target)
      }
    } catch (error) {
      // Why undo: a pack without its index is garbage Git cannot see; the next lookup fetches it again.
      for (const target of installed) {
        await rm(target, { force: true }).catch(() => {})
      }
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
      const alternates = objects ? await quarantineAlternates(objects) : undefined
      let scratchHostPath: string | undefined
      if (objects && alternates !== undefined) {
        startSweepOnce(objects.hostPath)
        const path = pathApiForGitPath(objects.hostPath)
        scratchHostPath = await mkdtemp(
          path.join(objects.hostPath, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
        ).catch(() => undefined)
      }
      if (!objects || alternates === undefined || !scratchHostPath) {
        // Why: bookkeeping must not block the user's action; run unquarantined.
        return command(undefined)
      }
      try {
        return await command({
          GIT_OBJECT_DIRECTORY: pathApiForGitPath(objects.gitPath).join(
            objects.gitPath,
            pathApiForGitPath(scratchHostPath).basename(scratchHostPath)
          ),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates
        })
      } finally {
        await keepFetchedPacks(scratchHostPath, objects.hostPath)
        await removeTree(scratchHostPath).catch((error: unknown) => {
          // Why: the stale sweep removes it later; the check's result still stands.
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
  sweepsByObjectsDirectory.clear()
}

export async function _settleGitObjectQuarantineSweepsForTests(): Promise<void> {
  await Promise.all(sweepsByObjectsDirectory.values())
}

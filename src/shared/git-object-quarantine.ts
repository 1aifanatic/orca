import { readlinkSync } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
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

// Why a floor even for a dead owner: it covers pid spaces the owner record cannot tell apart.
export const STALE_GIT_OBJECT_QUARANTINE_AGE_MS = 60 * 60 * 1000

// Why two weeks: `git gc` expires `objects/tmp_*` dirs at that age (gc.pruneExpire); with no
// owner this process can check, only Git's own abandonment rule is safe.
export const UNOWNED_GIT_OBJECT_QUARANTINE_AGE_MS = 14 * 24 * 60 * 60 * 1000

// Why: Orca processes sharing a repo (a second instance, dev and release builds) sweep each
// other's scratch dirs; only a provably dead owner makes one stale, as Git decides for gc.pid.
export const GIT_OBJECT_QUARANTINE_OWNER_FILE = 'orca-owner.json'

export type GitObjectQuarantineOwner = {
  pid: number
  hostname: string
  platform: string
  /** Linux only: a pid is meaningful only inside the pid namespace that issued it. */
  pidNamespace?: string
}

const sweptObjectsDirectories = new Set<string>()
let currentOwner: GitObjectQuarantineOwner | undefined

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

export function gitObjectQuarantineOwner(): GitObjectQuarantineOwner {
  if (!currentOwner) {
    let pidNamespace: string | undefined
    if (process.platform === 'linux') {
      try {
        pidNamespace = readlinkSync('/proc/self/ns/pid')
      } catch {}
    }
    currentOwner = {
      pid: process.pid,
      // Why platform too: a WSL distro takes the Windows hostname but has its own pids.
      hostname: hostname(),
      platform: process.platform,
      ...(pidNamespace ? { pidNamespace } : {})
    }
  }
  return currentOwner
}

async function readScratchOwner(scratch: string): Promise<GitObjectQuarantineOwner | undefined> {
  const path = pathApiForGitPath(scratch)
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(scratch, GIT_OBJECT_QUARANTINE_OWNER_FILE), 'utf8')
    )
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      'hostname' in parsed &&
      typeof parsed.hostname === 'string' &&
      'platform' in parsed &&
      typeof parsed.platform === 'string'
    ) {
      const pidNamespace =
        'pidNamespace' in parsed && typeof parsed.pidNamespace === 'string'
          ? parsed.pidNamespace
          : undefined
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        platform: parsed.platform,
        ...(pidNamespace ? { pidNamespace } : {})
      }
    }
  } catch {}
  return undefined
}

function sharesThisPidSpace(owner: GitObjectQuarantineOwner): boolean {
  const self = gitObjectQuarantineOwner()
  return (
    owner.hostname === self.hostname &&
    owner.platform === self.platform &&
    owner.pidNamespace === self.pidNamespace
  )
}

// Why only ESRCH: EPERM means the pid exists under another user, so a reused pid keeps the dir.
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function isStaleScratchDirectory(scratch: string, now: number): Promise<boolean> {
  const modified = await stat(scratch).then(
    (stats) => stats.mtimeMs,
    () => undefined
  )
  if (modified === undefined || now - modified < STALE_GIT_OBJECT_QUARANTINE_AGE_MS) {
    return false
  }
  const owner = await readScratchOwner(scratch)
  if (owner && sharesThisPidSpace(owner)) {
    return !isProcessAlive(owner.pid)
  }
  return now - modified >= UNOWNED_GIT_OBJECT_QUARANTINE_AGE_MS
}

async function sweepStaleScratchDirectories(objectsHostPath: string): Promise<void> {
  if (sweptObjectsDirectories.has(objectsHostPath)) {
    return
  }
  sweptObjectsDirectories.add(objectsHostPath)
  const path = pathApiForGitPath(objectsHostPath)
  const entries = await readdir(objectsHostPath).catch(() => [])
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith(GIT_OBJECT_QUARANTINE_DIR_PREFIX)) {
      continue
    }
    const scratch = path.join(objectsHostPath, entry)
    if (await isStaleScratchDirectory(scratch, now)) {
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
      let scratchHostPath: string | undefined
      if (objects) {
        await sweepStaleScratchDirectories(objects.hostPath)
        const path = pathApiForGitPath(objects.hostPath)
        scratchHostPath = await mkdtemp(
          path.join(objects.hostPath, GIT_OBJECT_QUARANTINE_DIR_PREFIX)
        ).catch(() => undefined)
        if (scratchHostPath) {
          // Why no fallback on failure: an ownerless dir is kept until Git's own two-week expiry.
          await writeFile(
            path.join(scratchHostPath, GIT_OBJECT_QUARANTINE_OWNER_FILE),
            JSON.stringify(gitObjectQuarantineOwner())
          ).catch(() => {})
        }
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
          // Why: a later process sweeps it once this one has exited; the check's result still stands.
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

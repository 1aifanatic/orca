// Local native-chat pastes live in an Orca-owned folder, so a restored draft can show and send them:
// a restore re-grants preview reads only for files that really are inside it, and old files expire.

import { lstat, readdir, realpath, stat, unlink } from 'node:fs/promises'
import path, { type PlatformPath } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { NATIVE_CHAT_PASTE_FOLDER } from '../../shared/native-chat-paste-folder'
import { authorizeExternalPath } from '../ipc/filesystem-auth'

// Why 30 days: far past the host's 24 h window for admitting a resent send that names a paste
// (AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS).
export const NATIVE_CHAT_PASTE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RESTORED_PASTES = 256

export type RestoredNativeChatPaste = { path: string; kept: boolean; exists: boolean }

export function nativeChatPasteFolder(): string {
  return path.join(getAppEnvironment().getPath('userData'), NATIVE_CHAT_PASTE_FOLDER)
}

/** A path as compared for containment: no `\\?\` prefix, and case-folded where the platform is. */
function comparablePath(value: string, pathApi: PlatformPath, platform: string): string {
  const unprefixed = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
  const normalized = pathApi.normalize(unprefixed)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True when `target` names something strictly inside `folder`; both must already be real paths. */
export function isInsideNativeChatPasteFolder(
  folder: string,
  target: string,
  pathApi: PlatformPath = path,
  platform: string = process.platform
): boolean {
  const relative = pathApi.relative(
    comparablePath(folder, pathApi, platform),
    comparablePath(target, pathApi, platform)
  )
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  )
}

/**
 * For each restored local paste: re-grants its preview read only when its real path is a file
 * inside the real paste folder (symlinks and junctions resolved). Never throws.
 */
export async function restoreNativeChatPastes(paths: unknown): Promise<RestoredNativeChatPaste[]> {
  if (!Array.isArray(paths)) {
    return []
  }
  let folder: string | null = null
  try {
    folder = await realpath(nativeChatPasteFolder())
  } catch {
    // No folder yet: nothing in it to keep.
  }
  return Promise.all(
    paths
      .slice(0, MAX_RESTORED_PASTES)
      .flatMap((value) =>
        typeof value === 'string' ? [restoreNativeChatPaste(folder, value)] : []
      )
  )
}

async function restoreNativeChatPaste(
  folder: string | null,
  restored: string
): Promise<RestoredNativeChatPaste> {
  const refused = { path: restored, kept: false, exists: false }
  if (folder === null || restored === '' || !path.isAbsolute(restored)) {
    return refused
  }
  try {
    const real = await realpath(restored)
    if (!isInsideNativeChatPasteFolder(folder, real) || !(await stat(real)).isFile()) {
      return refused
    }
    authorizeExternalPath(real)
    authorizeExternalPath(restored)
    return { path: restored, kept: true, exists: true }
  } catch {
    // Missing or unreadable: not kept, and nothing about an outside path is reported.
    return refused
  }
}

/** Deletes pastes older than the TTL. Symlinks and folders are skipped, never followed; failures
 *  are logged and never block startup. */
export async function sweepExpiredNativeChatPastes(now = Date.now()): Promise<void> {
  let folder: string
  let entries
  try {
    folder = nativeChatPasteFolder()
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }
    const file = path.join(folder, entry.name)
    try {
      const info = await lstat(file)
      if (info.isFile() && now - info.mtimeMs > NATIVE_CHAT_PASTE_TTL_MS) {
        await unlink(file)
      }
    } catch (error) {
      console.warn('[native-chat-pastes] could not expire a paste:', error)
    }
  }
}

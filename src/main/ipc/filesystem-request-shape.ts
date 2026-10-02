import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Store } from '../persistence'
import type { LocalFileAccess } from '../../shared/local-file-access'
import {
  PATH_ACCESS_DENIED_MESSAGE,
  resolveAuthorizedPath,
  type ResolveAuthorizedPathOptions
} from './filesystem-auth'
import { isDescendantOrEqual } from './filesystem-path-containment'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './filesystem/filesystem-file-content-inspection'
import { getDefaultFloatingWorkspacePath } from './floating-workspace-directory'
import { NOT_A_REGULAR_FILE_MESSAGE } from './filesystem/local-regular-file-read'

export const USER_FILE_NEEDS_ABSOLUTE_PATH_MESSAGE =
  'Access denied: a file opened by name needs an absolute path.'
export const DOCUMENT_RESOURCE_TYPE_MESSAGE =
  'Access denied: a document can only load images and PDFs it references.'

/** Desktop IPC's root check: the project roots plus the app-owned floating-workspace folder. */
export function resolveDesktopAuthorizedPath(
  targetPath: string,
  store: Store,
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  return resolveAuthorizedPath(targetPath, store, {
    ...options,
    extraRoots: [getDefaultFloatingWorkspacePath()]
  })
}

/** A file the user named is used where it is; no root applies, and nothing is remembered. */
export function resolveUserNamedLocalPath(targetPath: string): string {
  // Why isAbsolute on the raw input: resolve() would anchor `notes.txt` or `C:notes` to main's cwd.
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error(USER_FILE_NEEDS_ABSOLUTE_PATH_MESSAGE)
  }
  return resolve(targetPath)
}

/** A user-named path that must be an existing regular file, e.g. a notebook or a log being tailed. */
export async function resolveUserNamedRegularFile(targetPath: string): Promise<string> {
  const filePath = resolveUserNamedLocalPath(targetPath)
  if (!(await stat(filePath)).isFile()) {
    throw new Error(NOT_A_REGULAR_FILE_MESSAGE)
  }
  return filePath
}

async function isInsideDesktopRoots(documentPath: string, store: Store): Promise<boolean> {
  try {
    await resolveDesktopAuthorizedPath(documentPath, store)
    return true
  } catch {
    return false
  }
}

/**
 * An image or PDF a document references: limited to every project root when the document is in
 * one, else to the document's own folder. Out-of-scope targets are refused by path text before any
 * disk or network access, so a referenced network share is never contacted.
 */
export async function resolveDocumentResourcePath(
  targetPath: string,
  documentPath: string,
  store: Store
): Promise<string> {
  if (
    typeof targetPath !== 'string' ||
    !isAbsolute(targetPath) ||
    typeof documentPath !== 'string' ||
    !isAbsolute(documentPath)
  ) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  if (!PREVIEWABLE_BINARY_MIME_TYPES[extname(resolvedTarget).toLowerCase()]) {
    throw new Error(DOCUMENT_RESOURCE_TYPE_MESSAGE)
  }
  if (await isInsideDesktopRoots(documentPath, store)) {
    return resolveDesktopAuthorizedPath(resolvedTarget, store)
  }
  const documentFolder = dirname(resolve(documentPath))
  if (!isDescendantOrEqual(resolvedTarget, documentFolder)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = resolve(await realpath(resolvedTarget))
  if (!isDescendantOrEqual(realTarget, resolve(await realpath(documentFolder)))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return realTarget
}

// Why parse: IPC input is untyped, and an unrecognised shape must fall back to roots only.
function parseLocalFileAccess(access: unknown): LocalFileAccess | undefined {
  if (typeof access !== 'object' || access === null || !('kind' in access)) {
    return undefined
  }
  if (access.kind === 'user-file') {
    return { kind: 'user-file' }
  }
  if (
    access.kind === 'document-resource' &&
    'documentPath' in access &&
    typeof access.documentPath === 'string'
  ) {
    return { kind: 'document-resource', documentPath: access.documentPath }
  }
  return undefined
}

/** Resolves a desktop read/stat request by its declared shape; no shape means roots only. */
export async function resolveLocalFileRequestPath(
  targetPath: string,
  access: unknown,
  store: Store
): Promise<string> {
  const shape = parseLocalFileAccess(access)
  if (shape?.kind === 'user-file') {
    return resolveUserNamedLocalPath(targetPath)
  }
  if (shape?.kind === 'document-resource') {
    return resolveDocumentResourcePath(targetPath, shape.documentPath, store)
  }
  return resolveDesktopAuthorizedPath(targetPath, store)
}

/** Writes accept only the user-file shape: saving the open file the user named. */
export async function resolveLocalWriteRequestPath(
  targetPath: string,
  access: unknown,
  store: Store
): Promise<string> {
  return parseLocalFileAccess(access)?.kind === 'user-file'
    ? resolveUserNamedLocalPath(targetPath)
    : resolveDesktopAuthorizedPath(targetPath, store)
}

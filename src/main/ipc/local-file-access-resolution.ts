import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
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
import {
  isDeviceNamespacePath,
  isNetworkSharePath,
  isWindowsReservedDeviceName
} from './automatic-load-path-text'
import { NOT_A_REGULAR_FILE_MESSAGE } from './filesystem/local-regular-file-read'

export const USER_FILE_NEEDS_ABSOLUTE_PATH_MESSAGE =
  'Access denied: a file opened by name needs an absolute path.'
const USER_FILE_ACCESS: LocalFileAccess = { kind: 'user-file' }

export const CHAT_IMAGE_TYPE_MESSAGE = 'Access denied: a chat can only show local image files.'

/** Desktop IPC's root check: the project roots plus the app-owned floating-workspace folder. */
export async function resolveDesktopAuthorizedPath(
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

/**
 * A user-named path that must be an existing regular file, e.g. a notebook or a log being tailed.
 * Inside a project it resolves as the default check does, to the real file.
 */
export async function resolveUserNamedRegularFile(
  targetPath: string,
  store: Store
): Promise<string> {
  const filePath = await resolveLocalRequestPath(targetPath, USER_FILE_ACCESS, store, 'read')
  if (!(await stat(filePath)).isFile()) {
    throw new Error(NOT_A_REGULAR_FILE_MESSAGE)
  }
  return filePath
}

// Why every previewable type but PDF: chat shows these in an <img>, which renders no PDF.
function isChatImage(filePath: string): boolean {
  const extension = extname(filePath).toLowerCase()
  return Boolean(PREVIEWABLE_BINARY_MIME_TYPES[extension]) && extension !== '.pdf'
}

// Why the resolved path: `NUL.png\.` and `COM1.png\x\..` resolve to a device name.
function isRefusedAutomaticLoadPath(filePath: string): boolean {
  return isDeviceNamespacePath(filePath) || isWindowsReservedDeviceName(filePath)
}

/**
 * A file a document references (an image, typically) beyond what the default check allows: one in
 * the document's own folder, like the common markdown-preview rule, on a network share too when the
 * document is on it. A target outside the folder is refused by its path text before any
 * filesystem call; a symlink inside the folder is still resolved by the folder check.
 */
async function resolveDocumentResourcePath(
  targetPath: string,
  documentPath: string
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
  if (isRefusedAutomaticLoadPath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const documentFolder = dirname(resolve(documentPath))
  // Why the folder text check comes first: it refuses every host and share but the document's
  // own (compared case-insensitively on Windows) before a filesystem call could reach one.
  if (!isDescendantOrEqual(resolvedTarget, documentFolder)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = resolve(await realpath(resolvedTarget))
  if (!isDescendantOrEqual(realTarget, resolve(await realpath(documentFolder)))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (isRefusedAutomaticLoadPath(realTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return realTarget
}

/**
 * An image shown in a chat transcript, whoever's turn named it: any absolute local image file,
 * typed by its real target. Transcripts load as they scroll into view, so a network share is read
 * only inside a project the user added from it (the default check); anywhere else its path text,
 * like a device path, is refused before any filesystem call.
 */
async function resolveChatImagePath(targetPath: string, store: Store): Promise<string> {
  if (typeof targetPath !== 'string' || !isAbsolute(targetPath)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const resolvedTarget = resolve(targetPath)
  if (isRefusedAutomaticLoadPath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (isNetworkSharePath(resolvedTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = resolve(await realpath(resolvedTarget))
  if (isRefusedAutomaticLoadPath(realTarget)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  if (isNetworkSharePath(realTarget) && !isNetworkSharePath(resolvedTarget)) {
    // Why: a local link may still lead onto a share; that is readable only inside a project.
    await resolveDesktopAuthorizedPath(realTarget, store)
  }
  // Why the real target's type: `shot.png -> ~/.ssh/id_rsa` must not be read as an image.
  if (!isChatImage(realTarget)) {
    throw new Error(CHAT_IMAGE_TYPE_MESSAGE)
  }
  return realTarget
}

function isSameFolder(left: string, right: string): boolean {
  return isDescendantOrEqual(left, right) && isDescendantOrEqual(right, left)
}

/**
 * A write beside a document the user opened: the target must stay inside the document's own
 * folder, symlinks included. A rename acts on the named entry, not its target, and lands directly
 * in that folder, so its Undo (declared from the new name) is allowed too.
 */
async function resolveDocumentFolderPath(
  targetPath: string,
  documentPath: string,
  { rename = false }: { rename?: boolean } = {}
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
  const documentFolder = dirname(resolve(documentPath))
  if (
    isRefusedAutomaticLoadPath(resolvedTarget) ||
    !isDescendantOrEqual(resolvedTarget, documentFolder) ||
    // Why no real-path twin: a rename keeps its leaf, so its real parent is the folder's real path.
    (rename && !isSameFolder(dirname(resolvedTarget), documentFolder))
  ) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  const realTarget = rename
    ? resolve(await realpath(dirname(resolvedTarget)), basename(resolvedTarget))
    : resolve(await realpath(resolvedTarget))
  const realFolder = resolve(await realpath(documentFolder))
  if (isRefusedAutomaticLoadPath(realTarget) || !isDescendantOrEqual(realTarget, realFolder)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return realTarget
}

// Why only the document itself: a write beside it may rename that file, never a neighbour.
async function resolveDocumentRenameSource(
  targetPath: string,
  documentPath: string
): Promise<string> {
  if (typeof targetPath !== 'string' || resolve(targetPath) !== resolve(documentPath)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return resolveDocumentFolderPath(targetPath, documentPath, { rename: true })
}

// Why parse: IPC input is untyped, and an unrecognised access kind must fall back to roots only.
function parseLocalFileAccess(access: unknown): LocalFileAccess | undefined {
  if (typeof access !== 'object' || access === null || !('kind' in access)) {
    return undefined
  }
  if (access.kind === 'user-file') {
    return { kind: 'user-file' }
  }
  if (access.kind === 'chat-image') {
    return { kind: 'chat-image' }
  }
  if (
    access.kind === 'document-folder' &&
    'documentPath' in access &&
    typeof access.documentPath === 'string'
  ) {
    return { kind: 'document-folder', documentPath: access.documentPath }
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

/** What a desktop request does with its path; each declared kind adds access to only some. */
export type LocalRequestOperation = 'read' | 'write' | 'rename-from' | 'rename-to' | 'import-into'

type KindRule = (targetPath: string) => Promise<string>

function declaredKindRule(
  fileAccess: LocalFileAccess,
  operation: LocalRequestOperation,
  store: Store
): KindRule | undefined {
  switch (fileAccess.kind) {
    case 'user-file':
      return operation === 'read' || operation === 'write'
        ? async (targetPath) => resolveUserNamedLocalPath(targetPath)
        : undefined
    case 'document-resource':
      return operation === 'read'
        ? (targetPath) => resolveDocumentResourcePath(targetPath, fileAccess.documentPath)
        : undefined
    case 'chat-image':
      return operation === 'read'
        ? (targetPath) => resolveChatImagePath(targetPath, store)
        : undefined
    case 'document-folder':
      if (operation === 'rename-from') {
        return (targetPath) => resolveDocumentRenameSource(targetPath, fileAccess.documentPath)
      }
      if (operation === 'rename-to' || operation === 'import-into') {
        return (targetPath) =>
          resolveDocumentFolderPath(targetPath, fileAccess.documentPath, {
            rename: operation === 'rename-to'
          })
      }
      return undefined
  }
}

/**
 * The one resolver for desktop local file requests. A declared kind never refuses what the default
 * project check allows; its own rule only adds paths outside every project.
 */
export async function resolveLocalRequestPath(
  targetPath: string,
  access: unknown,
  store: Store,
  operation: LocalRequestOperation
): Promise<string> {
  // Why the leaf is kept: a rename acts on a link itself, never on what it points to.
  const options = { preserveSymlink: operation === 'rename-from' || operation === 'rename-to' }
  const fileAccess = parseLocalFileAccess(access)
  const kindRule = fileAccess && declaredKindRule(fileAccess, operation, store)
  if (!fileAccess || !kindRule) {
    return resolveDesktopAuthorizedPath(targetPath, store, options)
  }
  if (typeof targetPath !== 'string') {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  // Why device text first: a device is never a file to load, even inside a project.
  const automaticLoad = fileAccess.kind === 'document-resource' || fileAccess.kind === 'chat-image'
  if (automaticLoad && isRefusedAutomaticLoadPath(resolve(targetPath))) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  // Why the default check refuses an outside path by its text first: no share is contacted here.
  const insideRoots = await resolveDesktopAuthorizedPath(targetPath, store, options).catch(
    () => undefined
  )
  if (insideRoots === undefined) {
    return kindRule(targetPath)
  }
  if (automaticLoad && isRefusedAutomaticLoadPath(insideRoots)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }
  return insideRoots
}

/** A desktop read/stat request; no declared access means roots only. */
export function resolveLocalFileRequestPath(
  targetPath: string,
  access: unknown,
  store: Store
): Promise<string> {
  return resolveLocalRequestPath(targetPath, access, store, 'read')
}

/** A desktop save; user-file access adds the open file the user named. */
export function resolveLocalWriteRequestPath(
  targetPath: string,
  access: unknown,
  store: Store
): Promise<string> {
  return resolveLocalRequestPath(targetPath, access, store, 'write')
}

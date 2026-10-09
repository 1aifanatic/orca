import {
  isPathInsideWorktree,
  resolveTerminalFileLink,
  type ParsedTerminalFileLink
} from '@/lib/terminal-links'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import {
  isRemoteRuntimeFileOperation,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro
} from './terminal-file-open-routing'
import type { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import {
  getTerminalPathExistsCacheKey,
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'

/** Where detected path text resolves and is checked: a terminal pane's or a chat's folder. */
export type FileLinkHost = {
  cwd: string | null
  homePath?: string | null
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
}

export type FileLinkTarget = {
  /** The host path after WSL mapping; both the existence check and the open use it. */
  absolutePath: string
  line: number | null
  column: number | null
  fileContext: RuntimeFileOperationArgs
  isRemoteRuntimePath: boolean
  cacheKey: string
  isKnownWorktreeRoot: boolean
}

export type FileLinkPathExistence = ReturnType<typeof createTerminalPathExistenceBatch>

/** Detected path text to the host path it names; null when it cannot be a link. */
export function resolveFileLinkTarget(
  parsed: ParsedTerminalFileLink,
  host: FileLinkHost
): FileLinkTarget | null {
  const resolved = host.cwd ? resolveTerminalFileLink(parsed, host.cwd, host.homePath) : null
  if (!resolved) {
    return null
  }
  const absolutePath = mapTerminalFilePath(
    resolved.absolutePath,
    host.worktreePath,
    terminalLinkWslDistro(host.wslDistro, host.runtimeEnvironmentId)
  )
  const isKnownWorktreeRoot = Boolean(resolveKnownWorktreeRootPathLink(absolutePath))
  if (/[\\/]$/.test(parsed.pathText) && !isKnownWorktreeRoot) {
    return null
  }
  const fileContext = getTerminalFileContext(
    host.worktreeId,
    host.worktreePath,
    host.runtimeEnvironmentId
  )
  const isRemoteRuntimePath = isRemoteRuntimeFileOperation(fileContext, absolutePath)
  return {
    absolutePath,
    line: resolved.line,
    column: resolved.column,
    fileContext,
    isRemoteRuntimePath,
    cacheKey: getTerminalPathExistsCacheKey({
      absolutePath,
      connectionId: fileContext.connectionId,
      isRemoteRuntimePath,
      runtimeEnvironmentId: host.runtimeEnvironmentId
    }),
    isKnownWorktreeRoot
  }
}

/**
 * Whether this target may be checked with no click or hover. A check on this machine of a network
 * share outside the workspace may not: on Windows that stat opens SMB to the named server and sends
 * the user's credentials.
 */
export function mayCheckFileLinkTargetUnprompted(
  target: FileLinkTarget,
  host: FileLinkHost
): boolean {
  if (target.isKnownWorktreeRoot || target.fileContext.connectionId || target.isRemoteRuntimePath) {
    return true
  }
  const isNetworkShare = /^[\\/]{2}/.test(target.absolutePath) && !isWslUncPath(target.absolutePath)
  return !isNetworkShare || isPathInsideWorktree(target.absolutePath, host.worktreePath)
}

/** Rejects when the host cannot answer, so callers never mistake an outage for a missing file. */
export async function fileLinkTargetExists(
  target: FileLinkTarget,
  cache: Map<string, boolean>,
  pathExists: FileLinkPathExistence
): Promise<boolean> {
  // Why: exact known workspace roots must stay clickable for SSH or
  // stale local paths even when filesystem probing says "missing".
  if (target.isKnownWorktreeRoot) {
    return true
  }
  const exists =
    readTerminalPathExistsCache(cache, target.cacheKey) ??
    (await pathExists(target.fileContext, target.absolutePath, target.isRemoteRuntimePath))
  writeTerminalPathExistsCache(cache, target.cacheKey, exists)
  return exists
}

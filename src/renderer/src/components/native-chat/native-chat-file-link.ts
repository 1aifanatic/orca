import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget
} from '@/lib/explicit-file-link-target'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import { isNativeChatTabScopeCurrent, type NativeChatTabScope } from './native-chat-tab-scope'

export type NativeChatFileLinkContext = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
}

export type NativeChatResolvedFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

export type NativeChatFileLinkState = Pick<
  AppState,
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
> & {
  structuredSessionLaunchDirectoryByTabId?: AppState['structuredSessionLaunchDirectoryByTabId']
}

/**
 * Starts from the chat's own workspace; a tab missing from that workspace's bucket has no context.
 * Runtime owner and directory both come from `state`, so a result never mixes two snapshots.
 */
export function resolveNativeChatFileLinkContext(
  state: NativeChatFileLinkState,
  scope: NativeChatTabScope
): NativeChatFileLinkContext | null {
  if (!isNativeChatTabScopeCurrent(state, scope)) {
    return null
  }
  const worktreePath = resolveNativeChatTabDirectory(state, scope.tabId, scope.worktreeId)
  if (!worktreePath) {
    return null
  }

  return {
    worktreeId: scope.worktreeId,
    worktreePath,
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, scope.worktreeId)
  }
}

function resolvePathText(
  pathText: string,
  fallbackLine: number | null,
  context: NativeChatFileLinkContext
): NativeChatResolvedFileLink | null {
  const parsed = parseExplicitFileLinkTarget(pathText, { allowRelativeDirectoryPath: true })
  if (!parsed) {
    return null
  }
  // Native chat hrefs are explicit agent-authored links, so avoid the terminal
  // detector's conservative extension/filename filters.
  const resolved = resolveExplicitFileLinkTarget(parsed, context.worktreePath)
  if (!resolved) {
    return null
  }
  return {
    absolutePath: resolved.absolutePath,
    line: resolved.line ?? fallbackLine,
    column: resolved.column
  }
}

export function resolveNativeChatFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext | null
): NativeChatResolvedFileLink | null {
  if (!context) {
    return null
  }
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return null
  }
  return resolvePathText(route.pathText, route.line, context)
}

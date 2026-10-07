import type { AppState } from '@/store/types'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'

/**
 * The workspace a mounted native chat belongs to, as its parent already knows it. A bridge chat
 * is backed by a terminal tab; a structured chat by a unified agent-session tab. Readers verify
 * membership in this one workspace's bucket and never search other workspaces for the tab.
 */
export type NativeChatTabScope =
  | { kind: 'bridge'; worktreeId: string; tabId: string }
  | { kind: 'structured'; worktreeId: string; tabId: string }

export type NativeChatBridgeTabScope = Extract<NativeChatTabScope, { kind: 'bridge' }>

type NativeChatScopeTabState<
  TerminalRow extends { id: string } = { id: string },
  UnifiedRow extends { id: string; contentType?: string } = { id: string; contentType?: string }
> = {
  tabsByWorktree?: Record<string, readonly TerminalRow[] | undefined>
  unifiedTabsByWorktree?: Record<string, readonly UnifiedRow[] | undefined>
}

export function nativeChatTabScope(
  structured: boolean,
  worktreeId: string,
  tabId: string
): NativeChatTabScope {
  return { kind: structured ? 'structured' : 'bridge', worktreeId, tabId }
}

export function sameNativeChatTabScope(a: NativeChatTabScope, b: NativeChatTabScope): boolean {
  return a.kind === b.kind && a.worktreeId === b.worktreeId && a.tabId === b.tabId
}

/** The scope's own row, read from its workspace's bucket for its tab kind only. */
export function findNativeChatScopedTab<
  TerminalRow extends { id: string },
  UnifiedRow extends { id: string; contentType?: string }
>(
  state: NativeChatScopeTabState<TerminalRow, UnifiedRow>,
  scope: NativeChatTabScope
): TerminalRow | UnifiedRow | null {
  if (scope.kind === 'bridge') {
    return state.tabsByWorktree?.[scope.worktreeId]?.find((tab) => tab.id === scope.tabId) ?? null
  }
  return (
    state.unifiedTabsByWorktree?.[scope.worktreeId]?.find(
      // Why: a same-id row of another content type is not this chat.
      (tab) => tab.id === scope.tabId && tab.contentType === 'agent-session'
    ) ?? null
  )
}

/** Identity, not row-object, membership: a title update on the row keeps it current. */
export function isNativeChatTabScopeCurrent(
  state: NativeChatScopeTabState,
  scope: NativeChatTabScope
): boolean {
  return findNativeChatScopedTab(state, scope) !== null
}

/**
 * Runtime settings for a bridge chat's PTY writes, or null when its tab is no longer in its
 * workspace. A miss refuses the action; it never falls through to the globally selected runtime.
 */
export function resolveNativeChatBridgeRuntimeSettings(
  state: NativeChatScopeTabState & WorktreeRuntimeOwnerState,
  scope: NativeChatBridgeTabScope
): ReturnType<typeof getSettingsForWorktreeRuntimeOwner> | null {
  return isNativeChatTabScopeCurrent(state, scope)
    ? getSettingsForWorktreeRuntimeOwner(state, scope.worktreeId)
    : null
}

/** The scope's bucket and launch-directory pin, so other workspaces' tab churn does not invalidate. */
export type NativeChatScopedTabSlice = {
  scopedTerminalTabs: AppState['tabsByWorktree'][string] | undefined
  scopedUnifiedTabs: AppState['unifiedTabsByWorktree'][string] | undefined
  scopedLaunchDirectory: AppState['structuredSessionLaunchDirectoryByTabId'][string] | undefined
}

export function selectNativeChatScopedTabSlice(
  state: Pick<
    AppState,
    'tabsByWorktree' | 'unifiedTabsByWorktree' | 'structuredSessionLaunchDirectoryByTabId'
  >,
  scope: NativeChatTabScope
): NativeChatScopedTabSlice {
  return {
    // Why: a structured chat is not a terminal tab, so it never reads terminal inventory.
    scopedTerminalTabs:
      scope.kind === 'bridge' ? state.tabsByWorktree[scope.worktreeId] : undefined,
    scopedUnifiedTabs: state.unifiedTabsByWorktree[scope.worktreeId],
    scopedLaunchDirectory: state.structuredSessionLaunchDirectoryByTabId[scope.tabId]
  }
}

/** Adapts a scoped selection to the existing resolvers without subscribing to whole tab maps. */
export function nativeChatStateFromSelection<T extends NativeChatScopedTabSlice>(
  scope: NativeChatTabScope,
  selection: T
): Omit<T, keyof NativeChatScopedTabSlice> &
  Pick<
    AppState,
    'tabsByWorktree' | 'unifiedTabsByWorktree' | 'structuredSessionLaunchDirectoryByTabId'
  > {
  const { scopedTerminalTabs, scopedUnifiedTabs, scopedLaunchDirectory, ...catalog } = selection
  return {
    ...catalog,
    tabsByWorktree: scopedTerminalTabs ? { [scope.worktreeId]: scopedTerminalTabs } : {},
    unifiedTabsByWorktree: scopedUnifiedTabs ? { [scope.worktreeId]: scopedUnifiedTabs } : {},
    structuredSessionLaunchDirectoryByTabId: scopedLaunchDirectory
      ? { [scope.tabId]: scopedLaunchDirectory }
      : {}
  }
}

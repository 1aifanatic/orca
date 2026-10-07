import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import {
  settingsForWorktreeOperationRoute,
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteResolution
} from '@/lib/worktree-operation-route'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'
import {
  nativeChatStateFromSelection,
  selectNativeChatScopedTabSlice,
  type NativeChatScopedTabSlice,
  type NativeChatTabScope
} from './native-chat-tab-scope'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

/** The transcript must not read until ownership and its path are both known. */
export type NativeChatImageRuntimeContext = RuntimeFileOperationArgs | null

type OwnerState = Pick<
  AppState,
  | 'settings'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
  | 'structuredSessionLaunchDirectoryByTabId'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'runtimeEnvironmentCatalogHydrated'
  | 'removedRuntimeEnvironmentIds'
  | 'sshConnectionStates'
  | 'sshStateByEnvironment'
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

type OwnerSelection = Omit<
  OwnerState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'structuredSessionLaunchDirectoryByTabId'
> &
  NativeChatScopedTabSlice

// Keep the subscription limited to fields that can change image ownership, and to this chat's own
// tab bucket and pin. The derived context is computed during render, after Zustand has filtered updates.
export function selectNativeChatImageOwnerState(
  state: AppState,
  scope: NativeChatTabScope
): OwnerSelection {
  return {
    ...selectNativeChatScopedTabSlice(state, scope),
    settings: state.settings,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    folderWorkspaces: state.folderWorkspaces,
    floatingWorkspacePath: state.floatingWorkspacePath,
    projectGroups: state.projectGroups,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeEnvironmentCatalogHydrated: state.runtimeEnvironmentCatalogHydrated,
    removedRuntimeEnvironmentIds: state.removedRuntimeEnvironmentIds,
    sshConnectionStates: state.sshConnectionStates,
    sshStateByEnvironment: state.sshStateByEnvironment,
    activeWorktreeId: state.activeWorktreeId,
    activeWorkspaceExecutionHostId: state.activeWorkspaceExecutionHostId,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
  }
}

// Why: floating has no catalog row for the route resolver to find, and it always runs locally.
const FLOATING_WORKSPACE_ROUTE: WorktreeOperationRouteResolution = {
  kind: 'resolved',
  route: { executionHostId: 'local', runtimeEnvironmentId: null }
}

// Route settings are cloned for the runtime operation contract. Reuse that
// clone while the store's source settings and selected runtime are unchanged so
// consumers do not treat an unrelated store update as a new image owner.
const settingsBySource = new WeakMap<object, Map<string, AppState['settings']>>()

function stableSettingsForRoute(
  settings: AppState['settings'],
  runtimeEnvironmentId: string | null
): AppState['settings'] {
  if (!settings) {
    return settingsForWorktreeOperationRoute(settings, {
      executionHostId: null,
      runtimeEnvironmentId
    })
  }
  const source = settings as object
  let byRuntime = settingsBySource.get(source)
  if (!byRuntime) {
    byRuntime = new Map()
    settingsBySource.set(source, byRuntime)
  }
  const cacheKey = runtimeEnvironmentId ?? ''
  const cached = byRuntime.get(cacheKey)
  if (cached) {
    return cached
  }
  const resolved = settingsForWorktreeOperationRoute(settings, {
    executionHostId: null,
    runtimeEnvironmentId
  })
  byRuntime.set(cacheKey, resolved)
  return resolved
}

export function resolveNativeChatImageRuntimeContext(
  state: OwnerState,
  scope: NativeChatTabScope
): NativeChatImageRuntimeContext {
  const linkContext = resolveNativeChatFileLinkContext(state, scope)
  if (!linkContext) {
    return null
  }
  const routeResolution = isFloatingWorkspaceId(linkContext.worktreeId)
    ? FLOATING_WORKSPACE_ROUTE
    : resolveWorktreeOperationRouteResult(state, linkContext.worktreeId)
  if (routeResolution.kind !== 'resolved') {
    return null
  }
  const route = routeResolution.route
  const executionHostId =
    route.executionHostId ??
    (route.runtimeEnvironmentId ? toRuntimeExecutionHostId(route.runtimeEnvironmentId) : null)
  if (!executionHostId) {
    return null
  }
  const worktreePath = resolveNativeChatTabDirectory(
    state,
    scope.tabId,
    linkContext.worktreeId,
    executionHostId
  )
  if (!worktreePath) {
    return null
  }
  const host = parseExecutionHostId(executionHostId)
  if (!host) {
    return null
  }
  const context: RuntimeFileOperationArgs = {
    settings: stableSettingsForRoute(state.settings, route.runtimeEnvironmentId),
    worktreeId: linkContext.worktreeId,
    worktreePath,
    expectedExecutionHostId: host.kind === 'ssh' ? host.id : 'local'
  }
  if (host.kind === 'ssh') {
    try {
      const expectation = captureDirectSshMutationExpectation(
        state,
        host.targetId,
        route.runtimeEnvironmentId
      )
      context.expectedSshTargetId = expectation.expectedSshTargetId
      context.expectedSshConnectionGeneration = expectation.expectedSshConnectionGeneration
      if (!route.runtimeEnvironmentId) {
        context.connectionId = host.targetId
        context.expectedExternalSshTargetId = host.targetId
      }
    } catch {
      return null
    }
  }
  return context
}

export function useNativeChatImageRuntimeContext(
  scope: NativeChatTabScope
): NativeChatImageRuntimeContext {
  const { kind, worktreeId, tabId } = scope
  const ownerSelection = useAppStore(
    useShallow((state: AppState) =>
      selectNativeChatImageOwnerState(state, { kind, worktreeId, tabId })
    )
  )
  return useMemo(() => {
    const memoScope = { kind, worktreeId, tabId }
    return resolveNativeChatImageRuntimeContext(
      nativeChatStateFromSelection(memoScope, ownerSelection),
      memoScope
    )
  }, [kind, ownerSelection, tabId, worktreeId])
}

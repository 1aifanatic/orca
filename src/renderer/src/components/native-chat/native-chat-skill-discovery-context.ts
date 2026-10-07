import type { AppState } from '../../store/types'
import type { SkillDiscoveryTarget } from '../../../../shared/skills'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { resolveNativeChatTabDirectoryResolution } from './native-chat-tab-directory'
import {
  findNativeChatScopedTab,
  selectNativeChatScopedTabSlice,
  type NativeChatScopedTabSlice,
  type NativeChatTabScope
} from './native-chat-tab-scope'

type NativeChatSkillCatalogInputs = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'floatingWorkspacePath'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'projects'
  | 'repos'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'settings'
  | 'worktreesByRepo'
>

// Why no detected rows or catalog getter: skill discovery keeps its narrower directory fallback.
export type NativeChatSkillStateInputs = NativeChatSkillCatalogInputs &
  Pick<
    AppState,
    'tabsByWorktree' | 'unifiedTabsByWorktree' | 'structuredSessionLaunchDirectoryByTabId'
  >

/** What the skill hook subscribes to: catalogs plus only this chat's own tab bucket and pin. */
export type NativeChatSkillStateSelection = NativeChatSkillCatalogInputs & NativeChatScopedTabSlice

export type NativeChatSkillDiscoveryContext = {
  key: string
  cwd: string
  executionHostKind: 'local' | 'runtime' | 'ssh'
  runtimeTarget: RuntimeClientTarget
  discoveryTarget: SkillDiscoveryTarget
}

export type NativeChatSkillDiscoveryResolution =
  | { status: 'ready'; context: NativeChatSkillDiscoveryContext }
  /** Not a failure: the chat's folder is known soon, when its pin arrives. */
  | { status: 'awaiting-directory' }
  | { status: 'unavailable' }

export function selectNativeChatSkillStateInputs(
  state: AppState,
  scope: NativeChatTabScope
): NativeChatSkillStateSelection {
  return {
    ...selectNativeChatScopedTabSlice(state, scope),
    activeRepoId: state.activeRepoId,
    activeWorktreeId: state.activeWorktreeId,
    floatingWorkspacePath: state.floatingWorkspacePath,
    folderWorkspaces: state.folderWorkspaces,
    projectGroups: state.projectGroups,
    projects: state.projects,
    repos: state.repos,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    settings: state.settings,
    worktreesByRepo: state.worktreesByRepo
  }
}

/**
 * One pass over the chat's own row: its directory verdict and discovery route. Never searches
 * another workspace or tab kind on a miss.
 */
export function resolveNativeChatSkillDiscovery(
  state: NativeChatSkillStateInputs,
  scope: NativeChatTabScope
): NativeChatSkillDiscoveryResolution {
  const tab = findNativeChatScopedTab(state, scope)
  if (!tab) {
    return { status: 'unavailable' }
  }
  const { worktreeId } = scope
  // Why: the agent runs where its pane started. A pane launched in a
  // subdirectory must not scan (or share a cache key with) the worktree root.
  const startupCwd = ('startupCwd' in tab ? tab.startupCwd : undefined)?.trim()
  let cwd = startupCwd
  if (!cwd) {
    const directory = resolveNativeChatTabDirectoryResolution(state, scope.tabId, worktreeId)
    if (directory.status === 'awaiting-pin') {
      return { status: 'awaiting-directory' }
    }
    if (directory.status !== 'resolved') {
      return { status: 'unavailable' }
    }
    cwd = directory.directory
  }

  const hostId = getExecutionHostIdForWorktree(state, worktreeId)
  const parsedHost = parseExecutionHostId(hostId)
  if (parsedHost?.kind === 'ssh') {
    return {
      status: 'ready',
      context: {
        key: JSON.stringify(['ssh', hostId, cwd]),
        cwd,
        executionHostKind: 'ssh',
        runtimeTarget: { kind: 'local' },
        discoveryTarget: { cwd, worktreeId }
      }
    }
  }

  const runtimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  // Why: a selected global runtime is not proof that it owns this pane. Modern
  // panes carry an owner stamp; ambiguous legacy panes stay not-ready.
  if (parsedHost?.kind === 'runtime' && !runtimeEnvironmentId) {
    return { status: 'unavailable' }
  }
  const runtimeTarget: RuntimeClientTarget = runtimeEnvironmentId
    ? { kind: 'environment', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
  const projectRuntime = runtimeEnvironmentId
    ? undefined
    : getLocalProjectExecutionRuntimeContext(state, worktreeId)
  const projectRuntimeKey =
    projectRuntime?.status === 'resolved'
      ? projectRuntime.runtime.cacheKey
      : projectRuntime?.repair.cacheKey
  return {
    status: 'ready',
    context: {
      key: JSON.stringify([
        runtimeTarget.kind,
        runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : null,
        hostId,
        projectRuntimeKey ?? null,
        cwd
      ]),
      cwd,
      executionHostKind: runtimeEnvironmentId ? 'runtime' : 'local',
      runtimeTarget,
      // Why: worktreeId lets the owning runtime resolve its own WSL project
      // preference when this client cannot supply projectRuntime (environment-
      // owned panes resolve host semantics on the runtime, never here).
      discoveryTarget: {
        cwd,
        worktreeId,
        ...(projectRuntime ? { projectRuntime } : {})
      }
    }
  }
}

export function resolveNativeChatSkillDiscoveryContext(
  state: NativeChatSkillStateInputs,
  scope: NativeChatTabScope
): NativeChatSkillDiscoveryContext | null {
  const resolution = resolveNativeChatSkillDiscovery(state, scope)
  return resolution.status === 'ready' ? resolution.context : null
}

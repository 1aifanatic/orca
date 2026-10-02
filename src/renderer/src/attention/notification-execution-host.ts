import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  buildExecutionHostRegistry,
  type ExecutionHostRegistryEntry
} from '../../../shared/execution-host-registry'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { useAppStore } from '@/store'

type StoreState = ReturnType<typeof useAppStore.getState>
type NotificationOwnerState = WorktreeRuntimeOwnerState &
  Partial<Pick<StoreState, 'terminalLayoutsByTabId' | 'ptyIdsByTabId'>>

type NotificationSubject = {
  paneKey?: string
  ptyId?: string | null
  executionHostId?: string | null
  subscriptionTarget?: RuntimeClientTarget
}

/** Physical execution hosts stay distinct, including VM hosts shown on sidebar workspace rows. */
export function getNotificationExecutionHostId(
  state: NotificationOwnerState,
  workspaceId: string,
  subject: NotificationSubject = {}
): { executionHostId?: ExecutionHostId } {
  const pane = subject.paneKey ? parsePaneKey(subject.paneKey) : null
  const layout = pane ? state.terminalLayoutsByTabId?.[pane.tabId] : undefined
  const tabPtys = pane ? state.ptyIdsByTabId?.[pane.tabId] : undefined
  const ptyId = pane
    ? (layout?.ptyIdsByLeafId?.[pane.leafId] ?? (tabPtys?.length === 1 ? tabPtys[0] : undefined))
    : undefined
  const ptyHost = getPtyExecutionHost(subject.ptyId ?? ptyId)
  // An opaque remote PTY must not borrow an unrelated local workspace's owner.
  if (ptyHost === 'foreign') {
    return {}
  }
  const target = subject.subscriptionTarget
  const executionHostId =
    ptyHost ??
    parseExecutionHostId(subject.executionHostId)?.id ??
    (target?.kind === 'environment' ? toRuntimeExecutionHostId(target.environmentId) : null) ??
    getResolvedExecutionHostIdForWorktree(state, workspaceId)
  return executionHostId ? { executionHostId } : {}
}

export type NotificationHostState = Pick<
  StoreState,
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'settings'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
>

export function buildNotificationHostOptions(
  state: NotificationHostState
): ExecutionHostRegistryEntry[] {
  const hostIds = new Set<ExecutionHostId>()
  const add = (workspaceId: string, subject?: NotificationSubject): void => {
    const { executionHostId } = getNotificationExecutionHostId(state, workspaceId, subject)
    if (executionHostId) {
      hostIds.add(executionHostId)
    }
  }
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    for (const worktree of worktrees) {
      add(worktree.id, { executionHostId: worktree.hostId })
    }
  }
  for (const folder of state.folderWorkspaces) {
    add(folderWorkspaceKey(folder.id), { executionHostId: folder.executionHostId })
  }
  for (const [workspaceId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const layout = state.terminalLayoutsByTabId[tab.id]
      const ptyIds = new Set([
        tab.ptyId,
        ...(state.ptyIdsByTabId[tab.id] ?? []),
        ...Object.values(layout?.ptyIdsByLeafId ?? {})
      ])
      for (const ptyId of ptyIds) {
        add(workspaceId, { ptyId })
      }
    }
  }
  for (const tabs of Object.values(state.unifiedTabsByWorktree)) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session') {
        add(tab.worktreeId, tab)
      }
    }
  }
  return buildExecutionHostRegistry({
    ...state,
    // The run-target picker hides recipe VMs; notification controls must expose their live owners.
    includeRuntimeOwnedSshTargets: true,
    repos: [...state.repos, ...Array.from(hostIds, (executionHostId) => ({ executionHostId }))],
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  })
}

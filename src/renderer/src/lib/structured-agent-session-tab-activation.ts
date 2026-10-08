import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type { Tab } from '../../../shared/tab-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

/** The machine that holds the chat, when the caller knows it, and the pairing it was read under.
 *  Absent, the machine is inferred from the workspace as before. */
export type StructuredSessionMachine = {
  executionHostId?: ExecutionHostId
  pairingRevision?: number
}

/** The paired environment a named machine is, or null for this computer. */
export function structuredSessionMachineEnvironmentId(
  machine: StructuredSessionMachine | undefined,
  worktreeId: string
): string | null {
  if (machine?.executionHostId) {
    const parsed = parseExecutionHostId(machine.executionHostId)
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktreeId)
}

export function findStructuredAgentSessionTab(
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[]>>,
  args: { workspaceId: string; sessionId: string } & StructuredSessionMachine
): Tab | null {
  return (
    unifiedTabsByWorktree[args.workspaceId]?.find(
      (candidate) =>
        candidate.worktreeId === args.workspaceId &&
        candidate.contentType === 'agent-session' &&
        candidate.entityId === args.sessionId &&
        // A named machine never matches another machine's tab under a shared workspace id.
        (!args.executionHostId ||
          (candidate.executionHostId ?? LOCAL_EXECUTION_HOST_ID) === args.executionHostId)
    ) ?? null
  )
}

export function activateStructuredAgentSessionTab(
  args: {
    worktreeId: string
    tabId: string
  } & StructuredSessionMachine
): boolean {
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[args.worktreeId] ?? []).find(
    (candidate) => candidate.id === args.tabId && candidate.contentType === 'agent-session'
  )
  if (!tab) {
    return false
  }
  state.focusGroup(args.worktreeId, tab.groupId)
  state.activateTab(tab.id, { worktreeId: args.worktreeId })
  state.setActiveTabType('agent-session', args.worktreeId)
  const environmentId = structuredSessionMachineEnvironmentId(args, args.worktreeId)
  const target = getActiveRuntimeTarget({ activeRuntimeEnvironmentId: environmentId })
  const params = {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    tabId: `agent-session:${tab.entityId}`
  }
  void (args.pairingRevision === undefined
    ? callRuntimeRpc(target, 'session.tabs.activate', params)
    : callRuntimeRpc(target, 'session.tabs.activate', params, {
        // The pairing the chat was listed under; a re-paired machine is not asked.
        expectedEnvironmentPairingRevision: args.pairingRevision
      }))
  return true
}

export function activateStructuredAgentSessionById(
  args: {
    worktreeId: string
    sessionId: string
  } & StructuredSessionMachine
): boolean {
  const { worktreeId, sessionId, ...machine } = args
  const tab = findStructuredAgentSessionTab(useAppStore.getState().unifiedTabsByWorktree, {
    workspaceId: worktreeId,
    sessionId,
    ...machine
  })
  return tab ? activateStructuredAgentSessionTab({ worktreeId, tabId: tab.id, ...machine }) : false
}

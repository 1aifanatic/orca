import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../web-runtime-session'
import { isTerminalTabOwnedByAnotherHost } from './terminal-surfaces'
import type { WebSessionTabsSyncState } from './state'
import {
  createTerminalTabOwnerIndex,
  getTerminalTabOwnerWorktreeIds
} from '../../store/slices/terminal-tab-owner-index'

const canonicalTerminalOwners = createTerminalTabOwnerIndex()

export function indexTerminalSnapshotHosts(
  state: WebSessionTabsSyncState,
  worktreeId: string
): ReadonlyMap<string, ExecutionHostId> {
  return new Map(
    (state.unifiedTabsByWorktree[worktreeId] ?? []).flatMap((tab) =>
      tab.contentType === 'terminal' && tab.executionHostId
        ? [[tab.entityId, tab.executionHostId] as const, [tab.id, tab.executionHostId] as const]
        : []
    )
  )
}

export function findForeignTerminalSnapshotIdentity(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  terminalHostById: ReadonlyMap<string, ExecutionHostId>
): string | undefined {
  const incomingIds = new Set(
    snapshot.tabs.flatMap((tab) =>
      tab.type === 'terminal' ? [tab.parentTabId, toWebTerminalSurfaceTabId(tab.parentTabId)] : []
    )
  )
  const otherTerminalRows = new Map<string, ReadonlyMap<string, TerminalTab>>()
  const otherTerminalHosts = new Map<string, ReadonlyMap<string, ExecutionHostId>>()
  const hostsForWorktree = (worktreeId: string): ReadonlyMap<string, ExecutionHostId> => {
    let hosts = otherTerminalHosts.get(worktreeId)
    if (!hosts) {
      hosts = indexTerminalSnapshotHosts(state, worktreeId)
      otherTerminalHosts.set(worktreeId, hosts)
    }
    return hosts
  }
  for (const tab of state.tabsByWorktree[snapshot.worktree] ?? []) {
    if (
      incomingIds.has(tab.id) &&
      isTerminalTabOwnedByAnotherHost(tab, environmentId, terminalHostById.get(tab.id))
    ) {
      return tab.id
    }
  }
  // A pending terminal can have canonical chrome before its legacy row hydrates.
  for (const id of incomingIds) {
    if (isTerminalTabOwnedByAnotherHost({ ptyId: null }, environmentId, terminalHostById.get(id))) {
      return id
    }
    // Binding maps are global, so an ID collision in another workspace is unsafe too.
    for (const worktreeId of getTerminalTabOwnerWorktreeIds(state.tabsByWorktree, id) ?? []) {
      if (worktreeId === snapshot.worktree) {
        continue
      }
      let rows = otherTerminalRows.get(worktreeId)
      if (!rows) {
        rows = new Map((state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab]))
        otherTerminalRows.set(worktreeId, rows)
      }
      const tab = rows.get(id)
      const host = hostsForWorktree(worktreeId).get(id)
      if (tab && isTerminalTabOwnedByAnotherHost(tab, environmentId, host)) {
        return id
      }
    }
    for (const worktreeId of canonicalTerminalOwners.getOwnerWorktreeIds(
      state.unifiedTabsByWorktree,
      id
    ) ?? []) {
      if (worktreeId === snapshot.worktree) {
        continue
      }
      if (
        isTerminalTabOwnedByAnotherHost(
          { ptyId: null },
          environmentId,
          hostsForWorktree(worktreeId).get(id)
        )
      ) {
        return id
      }
    }
  }
  return undefined
}

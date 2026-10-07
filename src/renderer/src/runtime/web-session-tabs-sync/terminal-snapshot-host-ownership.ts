import { indexTerminalTabExecutionHosts } from '@/lib/terminal-tab-execution-hosts'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  toWebTerminalSurfaceTabId,
  toScopedWebTerminalSurfaceTabId
} from '../../../../shared/terminal-surface-id'
import { isTerminalTabOwnedByAnotherHost } from './terminal-surfaces'
import type { WebSessionTabsSyncState } from './state'
import {
  createTerminalTabOwnerIndex,
  getTerminalTabOwnerWorktreeIds
} from '../../store/slices/terminal-tab-owner-index'

const canonicalTerminalOwners = createTerminalTabOwnerIndex<Tab>((tab) =>
  tab.contentType === 'terminal' ? [tab.id, tab.entityId] : []
)

export function indexTerminalSnapshotHosts(
  state: WebSessionTabsSyncState,
  worktreeId: string
): ReadonlyMap<string, ExecutionHostId | null> {
  return indexTerminalTabExecutionHosts(state.unifiedTabsByWorktree[worktreeId] ?? [])
}

/** Keep ordinary IDs stable; namespace collisions before writing global pane records. */
export function resolveTerminalSnapshotLocalIds(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  terminalHostById: ReadonlyMap<string, ExecutionHostId | null>
): ReadonlyMap<string, string> {
  const localIds = new Map<string, string>()
  const currentRows = new Map(
    (state.tabsByWorktree[snapshot.worktree] ?? []).map((tab) => [tab.id, tab])
  )
  const rowsByWorktree = new Map<string, ReadonlyMap<string, TerminalTab>>([
    [snapshot.worktree, currentRows]
  ])
  const hostsByWorktree = new Map([[snapshot.worktree, terminalHostById]])
  const hostsForWorktree = (worktreeId: string): ReadonlyMap<string, ExecutionHostId | null> => {
    let hosts = hostsByWorktree.get(worktreeId)
    if (!hosts) {
      hosts = indexTerminalSnapshotHosts(state, worktreeId)
      hostsByWorktree.set(worktreeId, hosts)
    }
    return hosts
  }
  const conflicts = (id: string): boolean => {
    if (
      isTerminalTabOwnedByAnotherHost(
        currentRows.get(id) ?? { ptyId: null },
        environmentId,
        terminalHostById.get(id)
      )
    ) {
      return true
    }
    const worktreeIds = new Set([
      ...(getTerminalTabOwnerWorktreeIds(state.tabsByWorktree, id) ?? []),
      ...(canonicalTerminalOwners.getOwnerWorktreeIds(state.unifiedTabsByWorktree, id) ?? [])
    ])
    for (const worktreeId of worktreeIds) {
      if (worktreeId !== snapshot.worktree) {
        return true
      }
      let rows = rowsByWorktree.get(worktreeId)
      if (!rows) {
        rows = new Map((state.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab]))
        rowsByWorktree.set(worktreeId, rows)
      }
      if (
        isTerminalTabOwnedByAnotherHost(
          rows.get(id) ?? { ptyId: null },
          environmentId,
          hostsForWorktree(worktreeId).get(id)
        )
      ) {
        return true
      }
    }
    return false
  }
  for (const surface of snapshot.tabs) {
    if (surface.type !== 'terminal' || localIds.has(surface.parentTabId)) {
      continue
    }
    const ordinaryId = toWebTerminalSurfaceTabId(surface.parentTabId)
    const scopedId = toScopedWebTerminalSurfaceTabId(
      surface.parentTabId,
      environmentId,
      snapshot.worktree
    )
    const scopedAlreadyExists = terminalHostById.has(scopedId) || currentRows.has(scopedId)
    localIds.set(
      surface.parentTabId,
      scopedAlreadyExists || conflicts(ordinaryId) || conflicts(surface.parentTabId)
        ? scopedId
        : ordinaryId
    )
  }
  return localIds
}

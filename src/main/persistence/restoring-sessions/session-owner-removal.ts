import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { workspaceSessionPartitionHostId } from '../../../shared/workspace-session-partition-owner'
import { omitClosedTerminalTabRecordsForWorktrees } from '../../../shared/closed-terminal-tab-tombstones'
import { cloneWorkspaceSessionState, deleteOwnerKeyedSessionFields } from './session-owner-fields'

/** Why a workspace's rows are going. `removed`: Orca removed it, or git or its host confirmed it
 *  gone (including a folder or project removal). `forgotten`: the user chose Forget. `unlisted`: its
 *  host's scan stopped listing it, which is no proof it is gone. Callers state the cause; what each
 *  one takes with it is decided here. */
export type WorkspaceRemovalCause = 'removed' | 'forgotten' | 'unlisted'

export type WorkspaceSessionOwnerRemovalOptions = {
  cause: WorkspaceRemovalCause
  advanceTerminalTopologyRevision?: boolean
}

// Why unlisted keeps them: a wrong scan then costs only records waiting out their TTL.
function removalDropsCloseRecords(cause: WorkspaceRemovalCause): boolean {
  return cause !== 'unlisted'
}

function pruneCloseRecordsForOwners(
  next: WorkspaceSessionState,
  isRemovedOwner: (worktreeId: string) => boolean
): void {
  const records = omitClosedTerminalTabRecordsForWorktrees(
    next.closedTerminalTabTombstonesByTabId,
    isRemovedOwner
  )
  if (records !== next.closedTerminalTabTombstonesByTabId) {
    next.closedTerminalTabTombstonesByTabId = records
  }
}

// Scans the pane-key-keyed maps and the shutdown list once, removing every entry
// owned by a key matched by `isRemovedOwner` (or, for pty incarnations, whose tab
// was removed). Kept separate from the O(1) deletes so a batch prune scans each
// collection a single time regardless of how many owners are being removed.
export function deleteScannedSessionFieldsForOwners(
  next: WorkspaceSessionState,
  removedTabIds: ReadonlySet<string>,
  isRemovedOwner: (worktreeId: string) => boolean
): void {
  if (next.terminalPtyIncarnationsByPaneKey) {
    next.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(next.terminalPtyIncarnationsByPaneKey).filter(([paneKey]) => {
        const separator = paneKey.lastIndexOf(':')
        return separator < 1 || !removedTabIds.has(paneKey.slice(0, separator))
      })
    )
  }
  if (next.terminalSurfaceTombstonesByPaneKey) {
    next.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
      Object.entries(next.terminalSurfaceTombstonesByPaneKey).filter(
        ([, tombstone]) => !isRemovedOwner(tombstone.worktreeId)
      )
    )
  }
  if (next.sleepingAgentSessionsByPaneKey) {
    for (const [paneKey, record] of Object.entries(next.sleepingAgentSessionsByPaneKey)) {
      if (isRemovedOwner(record.worktreeId)) {
        delete next.sleepingAgentSessionsByPaneKey[paneKey]
      }
    }
  }
  next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
    (worktreeId) => !isRemovedOwner(worktreeId)
  )
}

// Remote (ssh:/runtime:) workspace state can exist in both the renderer's local blob and main's host
// partition, because the renderer falls back to 'local' whenever worktree ownership is unresolved.
export function workspaceSessionPartitionIdsForHost(
  hostId: string | null | undefined
): ExecutionHostId[] {
  const parsed = parseExecutionHostId(hostId)
  return parsed && parsed.id !== LOCAL_EXECUTION_HOST_ID
    ? [LOCAL_EXECUTION_HOST_ID, parsed.id]
    : [LOCAL_EXECUTION_HOST_ID]
}

/** The partition the host actually owns; the others are only spill surfaces for it. */
export const workspaceSessionOwnerPartitionForHost = workspaceSessionPartitionHostId

/**
 * Drop a deleted workspace's rows from every partition, not only the local blob.
 *
 * Which partition held them is not reliably derivable at delete time: main never persists a folder
 * workspace's `executionHostId`, and `RuntimeWorkspaceSessionController` can infer a connection
 * from the group's repos that the workspace row itself does not name. Boot now enumerates
 * partitions from persistence rather than from the repo catalog, so a row left in any of them is
 * adopted back on the next launch as a workspace that no longer exists. A deleted workspace owns
 * nothing anywhere, so removing it everywhere is the only derivation that cannot miss one.
 */
export function removeWorkspaceSessionOwnerEverywhere(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  ownerKey: string,
  options: WorkspaceSessionOwnerRemovalOptions
): void {
  state.workspaceSession = removeWorkspaceSessionOwner(state.workspaceSession, ownerKey, options)!
  const partitions = state.workspaceSessionsByHostId
  if (!partitions) {
    return
  }
  const next: Record<string, WorkspaceSessionState> = {}
  for (const [hostId, partition] of Object.entries(partitions)) {
    if (partition) {
      next[hostId] = removeWorkspaceSessionOwner(partition, ownerKey, options)!
    }
  }
  state.workspaceSessionsByHostId = next
}

export function removeWorkspaceSessionOwner(
  session: WorkspaceSessionState | undefined,
  ownerKey: string,
  options: WorkspaceSessionOwnerRemovalOptions
): WorkspaceSessionState | undefined {
  if (!session) {
    return session
  }
  const next = cloneWorkspaceSessionState(session)
  const removedTabIds = new Set<string>()
  deleteOwnerKeyedSessionFields(next, ownerKey, removedTabIds, options)
  deleteScannedSessionFieldsForOwners(next, removedTabIds, (worktreeId) => worktreeId === ownerKey)
  if (removalDropsCloseRecords(options.cause)) {
    pruneCloseRecordsForOwners(next, (worktreeId) => worktreeId === ownerKey)
  }
  return next
}

// Batch variant of removeWorkspaceSessionOwner: prunes every owner in `ownerKeys`
// with a single structuredClone and a single scan of each collection, instead of
// one clone+scan per owner. Project removal can touch many worktrees across many
// host partitions, so the per-owner clones added up to O(worktrees × hosts).
export function removeWorkspaceSessionOwners(
  session: WorkspaceSessionState | undefined,
  ownerKeys: ReadonlySet<string>,
  options: Pick<WorkspaceSessionOwnerRemovalOptions, 'cause'>
): WorkspaceSessionState | undefined {
  if (!session || ownerKeys.size === 0) {
    return session
  }
  const next = cloneWorkspaceSessionState(session)
  const removedTabIds = new Set<string>()
  for (const ownerKey of ownerKeys) {
    deleteOwnerKeyedSessionFields(next, ownerKey, removedTabIds)
  }
  deleteScannedSessionFieldsForOwners(next, removedTabIds, (worktreeId) =>
    ownerKeys.has(worktreeId)
  )
  if (removalDropsCloseRecords(options.cause)) {
    pruneCloseRecordsForOwners(next, (worktreeId) => ownerKeys.has(worktreeId))
  }
  return next
}

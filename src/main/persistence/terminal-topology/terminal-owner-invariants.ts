import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'

// The two terminal-layout invariants: a terminal is bound to at most one leaf, and a leaf id is in
// at most one tab. The binding write reports breaches; the load repair removes saved ones.

export type TerminalSessionPartition = { hostId: ExecutionHostId; session: WorkspaceSessionState }

export type TerminalLeafOwner = {
  hostId: ExecutionHostId
  worktreeId: string
  tab: TerminalTab
  leafId: string
  ptyId: string | undefined
  incarnationId: string | undefined
  /** Tree order across the partition, for deterministic tie-breaks. */
  order: number
}

export type TerminalOwnerConflictReason = 'pty_bound_to_other_leaf' | 'leaf_in_other_tab'

/** `runtime:` partitions belong to a remote Orca server and are written only by its tab sync. */
export function isTerminalOwnerPartition(hostId: ExecutionHostId): boolean {
  const kind = parseExecutionHostId(hostId)?.kind
  return kind === 'local' || kind === 'ssh'
}

/** Every leaf of every tab row; a layout left behind by a removed tab row owns nothing. */
export function collectTerminalLeafOwners({
  hostId,
  session
}: TerminalSessionPartition): TerminalLeafOwner[] {
  const owners: TerminalLeafOwner[] = []
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      const layout = session.terminalLayoutsByTabId?.[tab.id]
      for (const leafId of collectLayoutLeafIdsInOrder(layout?.root)) {
        owners.push({
          hostId,
          worktreeId,
          tab,
          leafId,
          ptyId: layout?.ptyIdsByLeafId?.[leafId],
          incarnationId: session.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${leafId}`],
          order: owners.length
        })
      }
    }
  }
  return owners
}

/** One terminal is one PTY incarnation; with either incarnation unrecorded, the PTY id alone. */
export function isSameTerminal(
  left: { ptyId: string | undefined; incarnationId?: string },
  right: { ptyId: string | undefined; incarnationId?: string }
): boolean {
  return (
    left.ptyId !== undefined &&
    left.ptyId === right.ptyId &&
    (left.incarnationId === undefined ||
      right.incarnationId === undefined ||
      left.incarnationId === right.incarnationId)
  )
}

/**
 * The saved leaf a binding would duplicate, if any. The same tab:leaf in two partitions is one
 * surface: the relay reattach still binds an SSH pane into `local`.
 */
export function findTerminalBindingConflict(
  binding: { tabId: string; leafId: string; ptyId: string; incarnationId?: string },
  partitions: readonly TerminalSessionPartition[]
): { reason: TerminalOwnerConflictReason; owner: TerminalLeafOwner } | null {
  // Legacy leaf ids are never written into leaf-keyed layout state, so they cannot own a terminal.
  if (!isTerminalLeafId(binding.leafId)) {
    return null
  }
  for (const partition of partitions) {
    if (!isTerminalOwnerPartition(partition.hostId)) {
      continue
    }
    for (const owner of collectTerminalLeafOwners(partition)) {
      if (owner.leafId === binding.leafId) {
        if (owner.tab.id !== binding.tabId) {
          return { reason: 'leaf_in_other_tab', owner }
        }
      } else if (isSameTerminal(owner, binding)) {
        return { reason: 'pty_bound_to_other_leaf', owner }
      }
    }
  }
  return null
}

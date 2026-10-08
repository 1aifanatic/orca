import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  adoptStrandedHostPartitionSession,
  withoutWorkspaces,
  workspaceIdsNamedByPartition
} from '../../../shared/workspace-session-stranded-partition-adoption'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import type { Store } from '../loading-store/store'
import { isTerminalOwnerPartition } from './terminal-topology-membership'

type ResidueStore = Pick<Store, 'getWorkspaceSession' | 'setWorkspaceSession'>

/**
 * Before a window save drops the rows of a workspace another partition homes, rows an older build
 * left here, main moves them to that home when it holds none, as its save of the window's routed
 * session used to (#19572, #26098).
 */
export function homeStrandedRowsBeforeWindowSave(
  store: ResidueStore,
  hostId: ExecutionHostId,
  homeHostIdOf: (worktreeId: string) => ExecutionHostId | null
): void {
  if (!isTerminalOwnerPartition(hostId)) {
    return
  }
  const strandedByHome = new Map<ExecutionHostId, Set<string>>()
  for (const [worktreeId, tabs] of Object.entries(
    store.getWorkspaceSession(hostId).tabsByWorktree
  )) {
    const home = homeHostIdOf(worktreeId)
    if (
      tabs.length > 0 &&
      home &&
      home !== hostId &&
      isTerminalOwnerPartition(home) &&
      (store.getWorkspaceSession(home).tabsByWorktree[worktreeId]?.length ?? 0) === 0
    ) {
      const stranded = strandedByHome.get(home) ?? new Set<string>()
      stranded.add(normalizeWorkspaceSessionKeyToWorkspaceId(worktreeId))
      strandedByHome.set(home, stranded)
    }
  }
  for (const [home, workspaceIds] of strandedByHome) {
    const residue = store.getWorkspaceSession(hostId)
    const others = workspaceIdsNamedByPartition(residue)
    workspaceIds.forEach((workspaceId) => others.delete(workspaceId))
    const homed = adoptStrandedHostPartitionSession(store.getWorkspaceSession(home), residue, {
      foreignSessionKeys: others
    })
    store.setWorkspaceSession(homed.session, home)
    store.setWorkspaceSession(withoutWorkspaces(residue, workspaceIds), hostId)
  }
}

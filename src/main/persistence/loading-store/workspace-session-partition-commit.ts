import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { observeTopologySinkWrite } from '../terminal-topology/terminal-topology-write-guard'

/** The one place the session sinks publish a partition, so the test-only write guard sees each. */
export function commitWorkspaceSessionPartition(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): void {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    observeTopologySinkWrite(state.workspaceSession, session)
    state.workspaceSession = session
    return
  }
  observeTopologySinkWrite(state.workspaceSessionsByHostId?.[hostId], session)
  state.workspaceSessionsByHostId = { ...state.workspaceSessionsByHostId, [hostId]: session }
}

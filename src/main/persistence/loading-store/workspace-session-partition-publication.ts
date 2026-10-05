import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'

/** The one place the session sinks publish a partition. */
export function publishWorkspaceSessionPartition(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState
): void {
  // Why: 'local' always lives in workspaceSession, never workspaceSessionsByHostId.local.
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    state.workspaceSession = session
    return
  }
  state.workspaceSessionsByHostId = { ...state.workspaceSessionsByHostId, [hostId]: session }
}

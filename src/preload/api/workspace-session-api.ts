import type { IssueInfo, PRInfo } from '../../shared/github/pull-request-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import type {
  TerminalTopologyReply,
  TerminalTopologySlice
} from '../../shared/terminal-topology-slice'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceConnectedClient,
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspacePeerImport,
  RemoteWorkspacePushStatusEvent
} from '../../shared/remote-workspace-types'

export type WorkspaceSessionApi = {
  session: {
    // hostId defaults to the 'local' partition on main, so omitting it stays backward-compatible.
    get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
    /** Partitions persistence holds, so boot reads them all instead of guessing from the catalog. */
    listHostIds: () => Promise<ExecutionHostId[]>
    set: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => Promise<void>
    patch: (args: WorkspaceSessionPatch, hostId?: ExecutionHostId) => Promise<void>
    /** Commits a terminal tab or split-pane close into main's membership. */
    closeTerminalSurface: (args: {
      worktreeId: string
      target: TerminalSurfaceCloseTarget
      reason?: 'user' | 'cleanup'
    }) => Promise<TerminalTopologyReply>
    /** Every worktree's current terminal topology; pull after subscribing to the pushes. */
    getTerminalTopologySlices: () => Promise<TerminalTopologySlice[]>
    onTerminalTopologyChanged: (callback: (slice: TerminalTopologySlice) => void) => () => void
    flush: () => Promise<void>
    readTerminalScrollback: (args: { ref: string }) => string | null
    setSync: (args: WorkspaceSessionState, hostId?: ExecutionHostId) => void
  }
  cache: {
    getGitHub: () => Promise<{
      pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
      issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
    }>
    setGitHub: (args: {
      cache: {
        pr: Record<string, { data: PRInfo | null; fetchedAt: number }>
        issue: Record<string, { data: IssueInfo | null; fetchedAt: number }>
      }
    }) => Promise<void>
  }
  remoteWorkspace: {
    get: (args: { targetId: string }) => Promise<RemoteWorkspaceObservedSnapshot | null>
    /** Commits a pull's session writes in main and records what this desktop and the host agree on. */
    importPeerTopology: (pull: RemoteWorkspacePeerImport) => Promise<void>
    listEnabledConnectedTargets: () => Promise<string[]>
    listConnectedClients: (args?: {
      targetIds?: string[]
    }) => Promise<{ targetId: string; clients: RemoteWorkspaceConnectedClient[] }[]>
    clientId: () => Promise<string>
    onChanged: (callback: (event: RemoteWorkspaceChangedEvent) => void) => () => void
    /** Main's report of each export it ran. */
    onPushStatus: (callback: (event: RemoteWorkspacePushStatusEvent) => void) => () => void
  }
}

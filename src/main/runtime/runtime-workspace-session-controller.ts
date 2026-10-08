import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { workspaceSessionPartitionHostId } from '../../shared/workspace-session-partition-owner'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { isTerminalOwnerPartition } from '../persistence/terminal-topology/terminal-topology-membership'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalTopologyOwners } from './terminal-topology-publisher'

const FOLDER_WORKSPACE_CONNECTION_AMBIGUOUS = 'folder_workspace_connection_ambiguous'

type RuntimeWorkspaceSessionDependencies = {
  getStore: () => RuntimeStore | null
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
  hasRuntimeOwnedPtyCandidate: (
    session: WorkspaceSessionState,
    worktreeId: string,
    tabs: WorkspaceSessionState['tabsByWorktree'][string]
  ) => boolean
}

export class RuntimeWorkspaceSessionController {
  constructor(private readonly deps: RuntimeWorkspaceSessionDependencies) {}

  private getPreferredHostId(worktreeId: string, store: RuntimeStore): ExecutionHostId | null {
    const scope = parseWorkspaceKey(worktreeId)
    if (scope?.type === 'folder') {
      const workspace = store
        ?.getFolderWorkspaces?.()
        .find((entry) => entry.id === scope.folderWorkspaceId)
      if (!workspace) {
        return null
      }
      // An explicit host is authoritative for folder workspaces. The connection
      // id is only a legacy fallback for records written before host ids existed.
      if (workspace.executionHostId != null) {
        const parsedHostId = parseExecutionHostId(workspace.executionHostId)?.id
        if (!parsedHostId) {
          return null
        }
        return parsedHostId
      }
      const connectionId = this.deps.resolveFolderConnectionId(workspace)
      return connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID
    }
    const resolvedWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
    const repo = store?.getRepo?.(getRepoIdFromWorktreeId(resolvedWorktreeId))
    return repo
      ? workspaceSessionPartitionHostId(getRepoExecutionHostId(repo))
      : LOCAL_EXECUTION_HOST_ID
  }

  /** An ambiguous folder's owner is unverifiable, not absent; any other failure propagates. */
  private tryGetPreferredHostId(worktreeId: string, store: RuntimeStore): ExecutionHostId | null {
    try {
      return this.getPreferredHostId(worktreeId, store)
    } catch (error) {
      if (error instanceof Error && error.message === FOLDER_WORKSPACE_CONNECTION_AMBIGUOUS) {
        return null
      }
      throw error
    }
  }

  private resolveHostId(
    worktreeId: string,
    preferredHostId: ExecutionHostId,
    persistedHostIds: readonly ExecutionHostId[],
    getWorkspaceSession: (hostId: ExecutionHostId) => WorkspaceSessionState
  ): ExecutionHostId {
    const hasPersistedTabs = (hostId: ExecutionHostId): boolean =>
      (getWorkspaceSession(hostId).tabsByWorktree[worktreeId]?.length ?? 0) > 0
    // Why: only runtime environment ids rotate across relay restarts. An empty SSH or
    // local partition is the truth, and `repoId::path` repeats across hosts, so a
    // same-id workspace elsewhere must never be adopted as this one's owner.
    if (
      parseExecutionHostId(preferredHostId)?.kind !== 'runtime' ||
      hasPersistedTabs(preferredHostId)
    ) {
      return preferredHostId
    }
    const persistedOwners = persistedHostIds.filter(
      (hostId) => hostId !== preferredHostId && hasPersistedTabs(hostId)
    )
    return persistedOwners.length === 1 ? persistedOwners[0]! : preferredHostId
  }

  tryGetHostId(worktreeId: string): ExecutionHostId | null {
    const store = this.deps.getStore()
    if (!store) {
      return null
    }
    const preferredHostId = this.getPreferredHostId(worktreeId, store)
    if (!preferredHostId) {
      return null
    }
    const persistedHostIds = store?.getWorkspaceSessionHostIds?.()
    if (!store.getWorkspaceSession || !persistedHostIds) {
      return preferredHostId
    }
    return this.resolveHostId(worktreeId, preferredHostId, persistedHostIds, (hostId) =>
      store.getWorkspaceSession!(hostId)
    )
  }

  getHostId(worktreeId: string): ExecutionHostId {
    const hostId = this.tryGetHostId(worktreeId)
    if (!hostId) {
      throw new Error('folder_workspace_not_found')
    }
    return hostId
  }

  get(worktreeId: string): WorkspaceSessionState | null {
    const hostId = this.tryGetHostId(worktreeId)
    return hostId ? (this.deps.getStore()?.getWorkspaceSession?.(hostId) ?? null) : null
  }

  /** The session only when the worktree's own host partition owns it, not a rotated-owner fallback. */
  getOwnPartition(worktreeId: string): WorkspaceSessionState | null {
    const store = this.deps.getStore()
    const hostId = store ? this.getPreferredHostId(worktreeId, store) : null
    return hostId && hostId === this.tryGetHostId(worktreeId)
      ? (store?.getWorkspaceSession?.(hostId) ?? null)
      : null
  }

  setForWorktree(worktreeId: string, session: WorkspaceSessionState): void {
    this.deps.getStore()?.setWorkspaceSession?.(session, this.getHostId(worktreeId))
  }

  getKnownWorktreeIds(): Set<string> {
    const store = this.deps.getStore()
    const repos = store?.getRepos?.() ?? []
    const repoIds = new Set(repos.map((repo) => repo.id))
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    const worktreeIds = new Set<string>()
    for (const hostId of hostIds) {
      const session = store?.getWorkspaceSession?.(hostId)
      for (const worktreeId of Object.keys(session?.tabsByWorktree ?? {})) {
        if (repoIds.has(getRepoIdFromWorktreeId(worktreeId))) {
          worktreeIds.add(worktreeId)
        }
      }
    }
    return worktreeIds
  }

  /** The one `local`/`ssh:` partition a worktree's terminal rows live in; null when unresolved or another server's. */
  getTerminalTopologyHomeHostId(worktreeId: string): ExecutionHostId | null {
    const store = this.deps.getStore()
    const hostId = store ? this.tryGetPreferredHostId(worktreeId, store) : null
    return hostId && isTerminalOwnerPartition(hostId) ? hostId : null
  }

  /**
   * Worktrees with terminal rows in their home partition. `runtime:` homes are another server's;
   * a home that can't be resolved (a missing or ambiguous folder) maps to null.
   */
  getTerminalTopologyOwners(): TerminalTopologyOwners {
    const owners: TerminalTopologyOwners = new Map()
    const store = this.deps.getStore()
    if (!store?.getWorkspaceSession) {
      return owners
    }
    for (const hostId of store.getWorkspaceSessionHostIds?.() ?? []) {
      if (!isTerminalOwnerPartition(hostId)) {
        continue
      }
      const session = store.getWorkspaceSession(hostId)
      for (const worktreeId of Object.keys(session.tabsByWorktree ?? {})) {
        const homeHostId = this.tryGetPreferredHostId(worktreeId, store)
        if (!homeHostId) {
          owners.set(worktreeId, null)
        } else if (homeHostId === hostId) {
          owners.set(worktreeId, { hostId, session })
        }
      }
    }
    return owners
  }

  getHydrationTargets(includeAllPersistedWorktrees: boolean): Map<string, WorkspaceSessionState> {
    const store = this.deps.getStore()
    if (!store) {
      return new Map()
    }
    const repos = store?.getRepos?.() ?? []
    const repoHostIdByRepoId = new Map(
      repos.map((repo) => [repo.id, getRepoExecutionHostId(repo)] as const)
    )
    const folderHostIdByWorkspaceId = new Map(
      (store?.getFolderWorkspaces?.() ?? []).map((workspace) => {
        const explicitHostId =
          workspace.executionHostId != null
            ? (parseExecutionHostId(workspace.executionHostId)?.id ?? null)
            : null
        const connectionId = explicitHostId ? null : this.deps.resolveFolderConnectionId(workspace)
        return [
          workspace.id,
          explicitHostId ??
            (connectionId ? toSshExecutionHostId(connectionId) : LOCAL_EXECUTION_HOST_ID)
        ] as const
      })
    )
    const hostIds = new Set<ExecutionHostId>(['local'])
    for (const repo of repos) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
    for (const hostId of store?.getWorkspaceSessionHostIds?.() ?? []) {
      hostIds.add(hostId)
    }

    const targets = new Map<string, WorkspaceSessionState>()
    const sessionsByHostId = new Map<ExecutionHostId, WorkspaceSessionState>()
    for (const hostId of hostIds) {
      const session = store?.getWorkspaceSession?.(hostId)
      if (!session) {
        continue
      }
      sessionsByHostId.set(hostId, session)
    }
    for (const [hostId, session] of sessionsByHostId) {
      for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
        const scope = parseWorkspaceKey(worktreeId)
        const catalogOwnerHostId =
          scope?.type === 'folder'
            ? (folderHostIdByWorkspaceId.get(scope.folderWorkspaceId) ?? null)
            : (repoHostIdByRepoId.get(
                getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : worktreeId)
              ) ?? LOCAL_EXECUTION_HOST_ID)
        const ownerHostId = this.resolveHostId(
          worktreeId,
          catalogOwnerHostId ?? LOCAL_EXECUTION_HOST_ID,
          [...sessionsByHostId.keys()],
          (candidateHostId) =>
            sessionsByHostId.get(candidateHostId) ?? store.getWorkspaceSession!(candidateHostId)
        )
        if (
          ownerHostId === hostId &&
          (includeAllPersistedWorktrees ||
            this.deps.hasRuntimeOwnedPtyCandidate(session, worktreeId, tabs))
        ) {
          targets.set(worktreeId, session)
        }
      }
    }
    return targets
  }
}

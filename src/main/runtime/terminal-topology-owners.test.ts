import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultWorkspaceSession } from '../../shared/constants'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'

const LOCAL_WT = 'repo-local::/wt'
const SSH_WT = 'repo-ssh::/remote/wt'
const RUNTIME_WT = 'repo-runtime::/srv/wt'
const AMBIGUOUS_FOLDER = 'folder:mixed'
const SSH_FOLDER = 'folder:remote'

function sessionWith(worktreeIds: string[]): WorkspaceSessionState {
  const session = getDefaultWorkspaceSession()
  for (const worktreeId of worktreeIds) {
    session.tabsByWorktree[worktreeId] = [
      {
        id: `tab-${worktreeId}`,
        worktreeId,
        ptyId: null,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  return session
}

function ownersFor(sessions: Map<ExecutionHostId, WorkspaceSessionState>) {
  const repos = [
    { id: 'repo-local' },
    { id: 'repo-ssh', connectionId: 'c1' },
    { id: 'repo-runtime', executionHostId: 'runtime:e1' }
  ]
  const folders = [
    { id: 'mixed', folderPath: '/mixed' },
    { id: 'remote', folderPath: '/remote', executionHostId: 'ssh:c1' }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller reads only repos, folder workspaces and workspace sessions.
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getFolderWorkspaces: () => folders,
    getWorkspaceSessionHostIds: () => [...sessions.keys()],
    getWorkspaceSession: (hostId: ExecutionHostId) =>
      sessions.get(hostId) ?? getDefaultWorkspaceSession()
  } as never
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: (workspace: FolderWorkspace) => {
      if (workspace.id === 'mixed') {
        throw new Error('folder_workspace_connection_ambiguous')
      }
      return null
    },
    hasRuntimeOwnedPtyCandidate: () => false
  })
  return controller.getTerminalTopologyOwners()
}

describe('terminal topology owners', () => {
  it('maps each worktree to its home partition only', () => {
    const local = sessionWith([LOCAL_WT, FLOATING_TERMINAL_WORKTREE_ID, SSH_WT])
    const ssh = sessionWith([SSH_WT, SSH_FOLDER])
    const owners = ownersFor(
      new Map([
        ['local', local],
        ['ssh:c1', ssh]
      ])
    )

    expect(owners).toEqual(
      new Map([
        [LOCAL_WT, { hostId: 'local', session: local }],
        [FLOATING_TERMINAL_WORKTREE_ID, { hostId: 'local', session: local }],
        [SSH_WT, { hostId: 'ssh:c1', session: ssh }],
        [SSH_FOLDER, { hostId: 'ssh:c1', session: ssh }]
      ])
    )
  })

  it('leaves out runtime homes and runtime partitions', () => {
    const owners = ownersFor(
      new Map([
        ['local', sessionWith([RUNTIME_WT])],
        ['runtime:e1', sessionWith([RUNTIME_WT, LOCAL_WT])]
      ])
    )

    expect(owners.size).toBe(0)
  })

  it('leaves out rows only in a partition that is not the home', () => {
    const owners = ownersFor(new Map([['local', sessionWith([SSH_WT])]]))

    expect(owners.has(SSH_WT)).toBe(false)
  })

  it('marks an ambiguous folder unresolved without losing the other worktrees', () => {
    const local = sessionWith([AMBIGUOUS_FOLDER, LOCAL_WT])
    const owners = ownersFor(new Map([['local', local]]))

    expect(owners).toEqual(
      new Map([
        [AMBIGUOUS_FOLDER, null],
        [LOCAL_WT, { hostId: 'local', session: local }]
      ])
    )
  })
})

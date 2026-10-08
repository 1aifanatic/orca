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
const UNCATALOGUED_WT = 'repo-gone::/wt'

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

function controllerFor(sessions: Map<ExecutionHostId, WorkspaceSessionState>) {
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
  return new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: (workspace: FolderWorkspace) => {
      if (workspace.id === 'mixed') {
        throw new Error('folder_workspace_connection_ambiguous')
      }
      return null
    },
    hasRuntimeOwnedPtyCandidate: () => false
  })
}

function ownersFor(sessions: Map<ExecutionHostId, WorkspaceSessionState>) {
  return controllerFor(sessions).getTerminalTopologyOwners()
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

  it('marks an uncatalogued repo with SSH rows unresolved, and keeps one with only local rows', () => {
    const ssh = sessionWith([UNCATALOGUED_WT])
    const controller = controllerFor(new Map([['ssh:c1', ssh]]))

    expect(controller.getTerminalTopologyOwners()).toEqual(new Map([[UNCATALOGUED_WT, null]]))
    expect(controller.getTerminalTopologyHomeHostId(UNCATALOGUED_WT)).toBeNull()

    const local = sessionWith([UNCATALOGUED_WT])
    expect(ownersFor(new Map([['local', local]]))).toEqual(
      new Map([[UNCATALOGUED_WT, { hostId: 'local', session: local }]])
    )
  })

  it('resolves one home for a layout write, and none for a runtime or ambiguous worktree', () => {
    const controller = controllerFor(new Map([['local', sessionWith([SSH_WT])]]))

    expect(controller.getTerminalTopologyHomeHostId(LOCAL_WT)).toBe('local')
    expect(controller.getTerminalTopologyHomeHostId(SSH_WT)).toBe('ssh:c1')
    expect(controller.getTerminalTopologyHomeHostId(SSH_FOLDER)).toBe('ssh:c1')
    expect(controller.getTerminalTopologyHomeHostId(RUNTIME_WT)).toBeNull()
    expect(controller.getTerminalTopologyHomeHostId(AMBIGUOUS_FOLDER)).toBeNull()
  })
})

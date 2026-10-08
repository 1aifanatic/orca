import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { ExecutionHostId } from '../shared/execution-host'
import type { TerminalTopologySlice } from '../shared/terminal-topology-slice'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import type { Store } from './persistence/loading-store/store'
import { makeTerminalTab, TEST_LEAF_1 } from './persistence-session-fixtures'
import { closeTestStores, createStore, makeRepo, testState } from './persistence-test-harness'
import { RuntimeWorkspaceSessionController } from './runtime/runtime-workspace-session-controller'
import { TerminalTopologyPublisher } from './runtime/terminal-topology-publisher'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

/** One worktree holding one bound single-pane tab. */
function sessionWithTab(worktreeId: string, ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [worktreeId]: [makeTerminalTab({ id: 'tab', worktreeId, ptyId })] },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: ptyId }
      }
    }
  }
}

/** Main's publisher wired to a real store the way the runtime wires it; records what follows the first pull. */
function watchPushes(store: Store) {
  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: () => null,
    hasRuntimeOwnedPtyCandidate: () => false
  })
  const pushes: TerminalTopologySlice[] = []
  const publisher = new TerminalTopologyPublisher(
    () => controller.getTerminalTopologyOwners(),
    (slice) => pushes.push(slice)
  )
  store.onWorkspaceSessionWritten(() => publisher.markDirty())
  const initial = publisher.snapshot()
  pushes.length = 0
  return {
    initial,
    pushesAfter: (write: () => unknown): TerminalTopologySlice[] => {
      write()
      publisher.flush()
      return pushes
    }
  }
}

function withdrawn(hostId: ExecutionHostId, worktreeId: string) {
  return expect.objectContaining({ hostId, worktreeId, tabs: [], layouts: {} })
}

describe('a window showing a worktree learns of main-side writes that remove or rekey it', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-topology-writer-pushes-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('withdraws a folder workspace deleted directly or with its project group', () => {
    for (const viaGroup of [false, true]) {
      const store = createStore()
      const group = store.createProjectGroup({
        name: 'Platform',
        parentPath: '/workspace/platform',
        createdFrom: 'folder-scan'
      })
      const folder = store.createFolderWorkspace({
        projectGroupId: group.id,
        folderPath: '/workspace/platform'
      })
      const key = folderWorkspaceKey(folder.id)
      store.setWorkspaceSession(sessionWithTab(key, 'pty-folder'))
      const { initial, pushesAfter } = watchPushes(store)
      expect(initial.map((slice) => slice.worktreeId)).toEqual([key])

      const pushes = pushesAfter(() =>
        viaGroup ? store.deleteProjectGroup(group.id) : store.removeFolderWorkspace(folder.id)
      )

      expect(pushes).toEqual([withdrawn('local', key)])
    }
  })

  it('withdraws the worktrees of a removed repo', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))
    store.setWorkspaceSession(sessionWithTab('r1::/repo', 'pty-repo'))
    const { initial, pushesAfter } = watchPushes(store)
    expect(initial).toHaveLength(1)

    expect(pushesAfter(() => store.removeProjectForHost('r1', 'local'))).toEqual([
      withdrawn('local', 'r1::/repo')
    ])
  })

  it("withdraws one host's worktree when a shared repo id is removed from that host only", () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'shared', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/remote/repo',
        connectionId: 'ssh-a',
        executionHostId: 'ssh:ssh-a'
      })
    )
    const worktreeId = 'shared::/local/repo/wt'
    store.setWorktreeMeta(worktreeId, { displayName: 'local-wt', hostId: 'local' })
    store.setWorkspaceSession(sessionWithTab(worktreeId, 'pty-local'))
    const { initial, pushesAfter } = watchPushes(store)
    expect(initial.map((slice) => slice.worktreeId)).toEqual([worktreeId])

    // The id survives on the SSH host, so only the per-host prune removes these rows.
    const pushes = pushesAfter(() => store.removeProjectForHost('shared', 'local'))

    expect(pushes).toEqual([withdrawn('local', worktreeId)])
  })

  it('withdraws the old identity and publishes the tab under the new one on a rename', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'repo-1', path: '/workspace' }))
    const oldId = 'repo-1::/workspace/feature'
    const newId = 'repo-1::/workspace/renamed'
    store.setWorkspaceSession(sessionWithTab(oldId, 'pty-feature'))
    const { pushesAfter } = watchPushes(store)

    const pushes = pushesAfter(() => store.migrateWorktreeIdentity(oldId, newId))

    expect(pushes).toEqual([
      withdrawn('local', oldId),
      expect.objectContaining({
        hostId: 'local',
        worktreeId: newId,
        tabs: [expect.objectContaining({ id: 'tab', ptyId: 'pty-feature' })]
      })
    ])
  })

  it('republishes an SSH worktree under the re-added target, with its bindings re-pointed', () => {
    const store = createStore()
    store.addRepo(
      makeRepo({
        id: 'remote',
        path: '/remote/repo',
        connectionId: 'old-target',
        executionHostId: 'ssh:old-target'
      })
    )
    const worktreeId = 'remote::/remote/repo'
    store.setWorkspaceSession(sessionWithTab(worktreeId, 'ssh:old-target@@pty-1'), 'ssh:old-target')
    const { initial, pushesAfter } = watchPushes(store)
    expect(initial.map((slice) => slice.hostId)).toEqual(['ssh:old-target'])

    const pushes = pushesAfter(() => store.reassignSshTargetId('old-target', 'new-target'))

    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ hostId: 'ssh:new-target', worktreeId })
    expect(pushes[0]!.tabs[0]!.ptyId).toBe('ssh:new-target@@pty-1')
    expect(pushes[0]!.layouts.tab!.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:new-target@@pty-1'
    })
  })

  it('pushes the unbound pane when main terminates its SSH lease', () => {
    const store = createStore()
    const worktreeId = 'wt1'
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'remote-pty',
      worktreeId,
      tabId: 'tab',
      leafId: TEST_LEAF_1,
      state: 'attached'
    })
    store.setWorkspaceSession(sessionWithTab(worktreeId, 'ssh:ssh-1@@remote-pty'))
    const { pushesAfter } = watchPushes(store)

    // The cleanup edits the session in place; the push must still see it.
    const pushes = pushesAfter(() =>
      store.markSshRemotePtyLease('ssh-1', 'ssh:ssh-1@@remote-pty', 'terminated')
    )

    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.tabs[0]!.ptyId).toBeNull()
    expect(pushes[0]!.layouts.tab!.ptyIdsByLeafId).toEqual({})
  })
})

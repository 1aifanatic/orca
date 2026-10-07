/**
 * The window commits a host snapshot's import through main in one call, before applying it, so
 * main records the agreement that keeps the import from exporting back.
 */
import { describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type {
  RemoteWorkspaceObservedSnapshot,
  RemoteWorkspacePeerImport
} from '../../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../shared/ssh-types'
import { createTestStore, makeWorktree } from '../store/slices/store-test-helpers'
import { applyDirectSshRemoteWorkspaceSnapshot } from './remote-workspace-snapshot-apply'
import type { DirectSshSnapshotApplyToken } from './direct-ssh-reconnect-coordinator-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const TARGET_ID = 'ssh-target-1'
const PATH = '/srv/proj/bug-cats'
const WORKTREE_ID = `repoA::${PATH}`

const authority: DirectSshAuthority = {
  targetId: TARGET_ID,
  providerEpoch: 'provider-epoch-1' as SshProviderEpoch,
  connectionGeneration: 1
}

function token(snapshotRevision: number): DirectSshSnapshotApplyToken {
  return {
    authority,
    catalogRevision: 0,
    repoFingerprint: 'fp',
    authorityRequirement: 'required',
    snapshotRevision,
    outcome: 'complete'
  }
}

function snapshot(revision: number, tabIds: readonly string[]): RemoteWorkspaceObservedSnapshot {
  return {
    namespace: 'workspace',
    revision,
    updatedAt: revision,
    schemaVersion: 1,
    hostObservationToken: `observation-${revision}`,
    session: {
      activeWorktreePath: PATH,
      activeTabId: tabIds[0] ?? null,
      tabsByWorktreePath: {
        [PATH]: tabIds.map((tabId, index) => ({
          id: tabId,
          worktreePath: PATH,
          ptyId: `pty-${tabId}`,
          title: `Terminal ${index + 1}`,
          customTitle: null,
          color: null,
          sortOrder: index,
          createdAt: index + 1
        }))
      },
      terminalLayoutsByTabId: {},
      activeWorktreePathsOnShutdown: [],
      activeTabIdByWorktreePath: { [PATH]: tabIds[0] ?? null },
      remoteSessionIdsByTabId: Object.fromEntries(tabIds.map((id) => [id, `pty-${id}`])),
      lastVisitedAtByWorktreePath: { [PATH]: revision },
      defaultTerminalTabsAppliedByWorktreePath: { [PATH]: true }
    }
  } satisfies RemoteWorkspaceObservedSnapshot
}

type TestStore = ReturnType<typeof createTestStore>

function seedCatalog(store: TestStore): void {
  store.setState({
    worktreesByRepo: {
      repoA: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repoA',
          path: PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ]
    },
    repos: [
      {
        id: 'repoA',
        path: '/srv/proj',
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      } as never
    ],
    // Why: only the IPC-backed reconnect is stubbed; hydration bookkeeping stays real because it is
    // the very signal under test.
    reconnectPersistedTerminals: (async () => {}) as never,
    setRemoteWorkspaceSyncStatus: (() => {}) as never
  })
}

async function importOf(
  store: TestStore,
  snap: RemoteWorkspaceObservedSnapshot
): Promise<RemoteWorkspacePeerImport> {
  const importPeerTopology = vi.fn(async (_pull: RemoteWorkspacePeerImport) => {})
  await applyDirectSshRemoteWorkspaceSnapshot({
    store,
    snapshot: snap,
    token: token(snap.revision),
    arrival: 1,
    isArrivalCurrent: () => true,
    isPreparationTokenCurrent: () => true,
    waitForWorkspaceSessionReady: async () => true,
    finalizeHydratedTerminals: () => 0,
    importPeerTopology
  })
  expect(importPeerTopology).toHaveBeenCalledOnce()
  return importPeerTopology.mock.calls[0][0]
}

describe('direct SSH snapshot import commit', () => {
  it('sends the merge to the worktree partition with the pull it came from', async () => {
    const store = createTestStore()
    seedCatalog(store)

    const pull = await importOf(store, snapshot(6, ['host-tab']))

    expect(pull).toMatchObject({
      targetId: TARGET_ID,
      revision: 6,
      hostObservationToken: 'observation-6',
      outcome: 'synced'
    })
    const sshPatch = pull.patches.find(({ hostId }) => hostId === `ssh:${TARGET_ID}`)?.patch
    expect(sshPatch?.tabsByWorktree?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['host-tab'])
    // Only what the merge rewrote; editor and browser state stay the window's own writes.
    const mergedFields = new Set([
      'activeRepoId',
      'activeWorktreeId',
      'activeWorkspaceKey',
      'activeTabId',
      'tabsByWorktree',
      'terminalLayoutsByTabId',
      'activeWorktreeIdsOnShutdown',
      'activeTabIdByWorktree',
      'remoteSessionIdsByTabId',
      'lastVisitedAtByWorktreeId',
      'defaultTerminalTabsAppliedByWorktreeId'
    ])
    for (const { patch } of pull.patches) {
      expect(Object.keys(patch).filter((field) => !mergedFields.has(field))).toEqual([])
    }
  })

  it('reports kept-local when the merge keeps a tab the host has not seen', async () => {
    const store = createTestStore()
    seedCatalog(store)
    await importOf(store, snapshot(1, ['agent']))
    // Created during the download, so the host's next snapshot still lists only `agent`.
    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          ...(store.getState().tabsByWorktree[WORKTREE_ID] ?? []),
          {
            id: 'setup',
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'setup',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      }
    })

    await expect(importOf(store, snapshot(2, ['agent']))).resolves.toMatchObject({
      outcome: 'kept-local'
    })
    await expect(importOf(store, snapshot(3, ['agent', 'setup']))).resolves.toMatchObject({
      outcome: 'synced'
    })
  })

  it('reports a conflict when the window cannot place every host tab', async () => {
    vi.useFakeTimers()
    try {
      const store = createTestStore()
      seedCatalog(store)
      store.setState({ worktreesByRepo: {} })
      const pending = importOf(store, snapshot(7, ['host-tab']))
      await vi.runAllTimersAsync()

      await expect(pending).resolves.toMatchObject({ revision: 7, outcome: 'conflict' })
    } finally {
      vi.useRealTimers()
    }
  })
})

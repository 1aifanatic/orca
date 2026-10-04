import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type { OrcadMigrationManifest } from '../../shared/orcad-migration-manifest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshManagedServerStatus, SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { fakeOrcadMigrationDestination } from '../ssh/orcad-migration-destination-fake'
import { assessOrcadMigrationTerminals } from '../ssh/orcad-migration-terminal-gate'
import { SshConnectionStore } from '../ssh/ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn() }
})
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: () => false
}))
vi.mock('../ssh/orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: vi.fn() }))
vi.mock('./ssh-connect-flow', () => ({ connectTarget: vi.fn() }))
vi.mock('./ssh-terminate-sessions', () => ({ terminateSshTargetSessions: vi.fn() }))

const { convertSshTargetToManagedOrcad } = await import('../ssh/orcad-runtime-conversion')
const { moveSshHostToManagedServer } = await import('./ssh-managed-server-move')

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}
const HOST_ID = `ssh:${TARGET.id}` as const
const WORKTREE = 'repo-1::/srv/app'
const LEAF = '11111111-1111-4111-8111-111111111111'
const RELAY_PTY = 'pty2:relay:1'

let userDataPath: string
let store: Store
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-move-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.state.targetStore = new SshConnectionStore(store as never)
  destination = fakeOrcadMigrationDestination()
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const id = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))!
    if (!listEnvironments(path).some((entry) => entry.id === id)) {
      addManagedOrcadEnvironment(path, {
        id,
        name: args.name,
        pairingCode: encodePairingOffer({
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:46768/',
          deviceToken: 'device-token',
          publicKeyB64: 'public-key'
        }),
        orcadDeployment: {
          sshTargetId: TARGET.id,
          sshTargetGeneration: 2,
          localPort: 46_768,
          remotePort: 6_768
        }
      })
    }
    return { outcome: 'created', environment: {}, activeVersion: '1.0.0' }
  })
})

afterEach(async () => {
  await closeTestStores()
  rmSync(userDataPath, { recursive: true, force: true })
})

/** One open relay terminal tab: its tab, layout leaf and pane incarnation all name the relay PTY. */
function openRelayTerminal(): void {
  const appPtyId = `${HOST_ID}@@${RELAY_PTY}`
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(HOST_ID),
      activeRepoId: 'repo-1',
      activeWorktreeId: WORKTREE,
      activeTabId: 'tab-term',
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'tab-term',
            ptyId: appPtyId,
            worktreeId: WORKTREE,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-term': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: appPtyId }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`tab-term:${LEAF}`]: 'incarnation-1' },
      activeWorktreeIdsOnShutdown: [WORKTREE]
    },
    HOST_ID
  )
  store.upsertSshRemotePtyLease({
    targetId: TARGET.id,
    ptyId: RELAY_PTY,
    worktreeId: WORKTREE,
    tabId: 'tab-term',
    leafId: LEAF,
    state: 'detached'
  })
}

function moveDeps() {
  let status: SshManagedServerStatus | undefined
  return {
    getTarget: (targetId: string) => store.getSshTarget(targetId),
    // The relay acknowledged stopping its one terminal.
    terminate: vi.fn(async (targetId: string) => {
      store.markSshRemotePtyLease(targetId, RELAY_PTY, 'terminated')
      return { terminated: 1, unverifiable: 0 }
    }),
    relayTerminals: async (target: SshTarget) => {
      const proof = await assessOrcadMigrationTerminals(store, target.id, null)
      return proof.verdict === 'exited'
        ? { verdict: 'exited' as const, count: 0 }
        : { verdict: proof.verdict, count: proof.ptyIds.length }
    },
    // The reconnect's server decision: the census passed, so it converts.
    connect: vi.fn(async (targetId: string) => {
      const result = await convertSshTargetToManagedOrcad(userDataPath, {
        sshTargetId: targetId,
        name: TARGET.label,
        listRelayPtyIds: null,
        destinationFor: () => destination,
        releaseDirectSession: async () => {},
        retireSource: () => false
      })
      status =
        result.outcome === 'converted'
          ? { kind: 'managed', environmentId: result.environment.id }
          : { kind: 'relay', reason: 'refused', detail: 'reason' in result ? result.reason : '' }
    }),
    serverStatus: () => status,
    report: vi.fn()
  }
}

describe('moving a host whose one relay terminal kept it on the relay', () => {
  it('stops the terminal, converts, and carries its tab to orcad without the relay PTY', async () => {
    openRelayTerminal()
    const deps = moveDeps()

    await expect(moveSshHostToManagedServer(TARGET.id, deps)).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(deps.terminate).toHaveBeenCalledWith(TARGET.id)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stage receives the migration manifest as its first argument.
    const manifest = destination.stage.mock.calls[0]?.[0] as OrcadMigrationManifest
    const session = manifest.payload.dormantState?.workspaceSession
    // No relay PTY id survives, so the tab spawns a fresh shell on the managed server.
    expect(Object.values(session?.tabsByWorktree ?? {}).flat()).toMatchObject([
      { id: 'tab-term', ptyId: null }
    ])
    expect(session?.terminalLayoutsByTabId?.['tab-term']?.ptyIdsByLeafId).toBeUndefined()
    expect(session?.terminalPtyIncarnationsByPaneKey ?? {}).toEqual({})
  })
})

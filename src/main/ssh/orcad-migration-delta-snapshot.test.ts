import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { Repo } from '../../shared/repo-types'
import type { SshTarget } from '../../shared/ssh-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { runOrcadDeltaMove } from './orcad-migration-delta-move'
import { reconcileManagedOrcadSshTargets } from './orcad-retained-source'
import { SshConnectionStore } from './ssh-connection-store'
import { runTargetLifecycle } from '../ipc/ssh-target-lifecycle-queue'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn() }
})
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: () => false
}))
vi.mock('./orcad-runtime-deployment', () => ({ createManagedOrcadEnvironment: mocks.deploy }))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.ensureTunnel }))

const { convertSshTargetToManagedOrcad } = await import('./orcad-runtime-conversion')

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

let userDataPath: string
let store: Store
let sshStore: SshConnectionStore
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

function repo(id: string, path: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-delta-snapshot-'))
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  store.addSshTarget(TARGET)
  store.addRepo(repo('repo-1', '/srv/app'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  sshStore = new SshConnectionStore(store as never)
  mocks.state.targetStore = sshStore
  destination = fakeOrcadMigrationDestination()
  mocks.ensureTunnel.mockResolvedValue(undefined)
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

const now = () => new Date('2026-10-03T00:00:00.000Z')

const HOST_ID = `ssh:${TARGET.id}` as const

/** An unsaved editor draft in the host's session partition, as the renderer saves it. */
function saveDraft(worktreeId: string, content: string): void {
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(HOST_ID),
      openFilesByWorktree: {
        [worktreeId]: [
          {
            filePath: '/srv/notes.md',
            relativePath: 'notes.md',
            worktreeId,
            language: 'markdown',
            dirtyDraftContent: content
          }
        ]
      }
    },
    HOST_ID
  )
}

function savedDraft(worktreeId: string): string | undefined {
  return store.getWorkspaceSession(HOST_ID).openFilesByWorktree?.[worktreeId]?.[0]
    ?.dirtyDraftContent
}

/** Converted with source retirement off, then an older build adds what `addOnOlderBuild` adds. */
async function convertedThenAdded(addOnOlderBuild: () => string): Promise<string> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      listRelayPtyIds: Object.assign(async () => [], { previous: async () => [] }),
      destinationFor: () => destination,
      releaseDirectSession: async () => {},
      now,
      retireSource: () => false
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
  const worktreeId = addOnOlderBuild()
  saveDraft(worktreeId, 'draft before the move')
  reconcileManagedOrcadSshTargets(userDataPath, store, now)
  expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
  return worktreeId
}

/** The relay answers only after `whileChecking` ran, as a user typing during the check would. */
function deltaMoveTypingDuringTerminalCheck(whileChecking: () => void) {
  const list = async (): Promise<string[]> => {
    whileChecking()
    return []
  }
  return runOrcadDeltaMove({
    userDataPath,
    store,
    claims: sshStore.getOrcadRuntimeClaims(),
    target: store.getSshTarget(TARGET.id)!,
    environment: listEnvironments(userDataPath)[0]!,
    destination,
    listRelayPtyIds: Object.assign(list, { previous: async () => [] }),
    releaseDirectSession: async () => {},
    ensureTunnel: async () => {},
    runTargetLifecycle,
    now
  })
}

describe('a draft typed while a delta move checks terminals', () => {
  it.each([
    [
      'a repository the older build added',
      () => {
        store.addRepo(repo('repo-2', '/srv/tool'))
        return 'repo-2::/srv/tool'
      }
    ],
    [
      'a folder workspace the older build added',
      () => {
        const group = store.createProjectGroup({
          name: 'folders',
          parentPath: '/srv/folders',
          connectionId: TARGET.id,
          createdFrom: 'manual'
        })
        const folder = store.createFolderWorkspace({
          projectGroupId: group.id,
          folderPath: '/srv/folders/notes',
          connectionId: TARGET.id
        })
        return folderWorkspaceKey(folder.id)
      }
    ]
  ])('in %s refuses the move rather than bless the newer draft', async (_label, add) => {
    const worktreeId = await convertedThenAdded(add)

    await expect(
      deltaMoveTypingDuringTerminalCheck(() =>
        saveDraft(worktreeId, 'typed while the terminal check awaited')
      )
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_delta_source_changed' })

    // Nothing moved, so nothing will be retired: the newer draft stays, and the host stays marked.
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    expect(savedDraft(worktreeId)).toBe('typed while the terminal check awaited')
  })

  it('journals the baseline the manifest saw when nothing changed during the check', async () => {
    const worktreeId = await convertedThenAdded(() => {
      store.addRepo(repo('repo-2', '/srv/tool'))
      return 'repo-2::/srv/tool'
    })

    await expect(deltaMoveTypingDuringTerminalCheck(() => {})).resolves.toMatchObject({
      outcome: 'moved'
    })
    expect(savedDraft(worktreeId)).toBe('draft before the move')
    // Back to managed, and the next start finds the source as the delta baseline recorded it.
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })
})

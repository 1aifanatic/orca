import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { retireRetainedOrcadSourceChain } from './orcad-retained-source-retirement'
import { SshConnectionStore } from './ssh-connection-store'

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
const HOST_ID = `ssh:${TARGET.id}` as const
const REPO_WORKTREE = 'repo-1::/srv/app'

let userDataPath: string
let store: Store

function openStore(): void {
  store = createSqliteTestStore(Store, { dataFile: join(userDataPath, 'orca-data.json') })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SshConnectionStore wraps the real test store it is given.
  mocks.state.targetStore = new SshConnectionStore(store as never)
}

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-retire-retry-'))
  openStore()
  store.addSshTarget(TARGET)
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

function saveDraft(worktreeId: string, content: string, hostId?: typeof HOST_ID): void {
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(hostId),
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
    hostId
  )
}

function draftIn(worktreeId: string, hostId?: typeof HOST_ID): string | undefined {
  return store.getWorkspaceSession(hostId).openFilesByWorktree?.[worktreeId]?.[0]?.dirtyDraftContent
}

const head = () => listOrcadMigrationSourceCutovers(userDataPath).at(-1)

/** A repository host, or a folder-only one; returns the workspace key the draft lives under. */
function seedSource(kind: 'repository' | 'folder'): string {
  if (kind === 'repository') {
    store.addRepo({
      id: 'repo-1',
      path: '/srv/app',
      displayName: 'App',
      badgeColor: '#737373',
      addedAt: 1,
      kind: 'git',
      connectionId: TARGET.id
    })
    return REPO_WORKTREE
  }
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

async function convertKeepingSource(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      listRelayPtyIds: Object.assign(async () => [], { previous: async () => [] }),
      destinationFor: () => fakeOrcadMigrationDestination(),
      releaseDirectSession: async () => {},
      retireSource: () => false
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
}

const retireChain = () =>
  retireRetainedOrcadSourceChain(userDataPath, store, store.getSshTarget(TARGET.id)!, (_id, run) =>
    run()
  )

/** Runs `write` once, during the next profile flush, as a save landing mid-retirement. */
function writeDuringNextFlush(write: () => void): void {
  const flush = store.flushPendingOrThrowAsync.bind(store)
  let wrote = false
  store.flushPendingOrThrowAsync = async (options) => {
    if (!wrote) {
      wrote = true
      write()
    }
    return flush(options)
  }
}

describe('retiring a retained source twice', () => {
  it.each([
    ['a repository worktree', 'repository' as const, false],
    ['a repository worktree, across a restart', 'repository' as const, true],
    ['a folder-only host, across a restart', 'folder' as const, true]
  ])('never deletes a draft changed mid-retirement in %s', async (_label, kind, restart) => {
    const workspace = seedSource(kind)
    saveDraft(workspace, 'committed draft', HOST_ID)
    await convertKeepingSource()

    // A save with a newer draft lands in the local partition during the first flush.
    writeDuringNextFlush(() => saveDraft(workspace, 'NEW draft during flush'))
    await expect(retireChain()).rejects.toThrow('orcad_migration_retirement_conflict')
    expect(head()?.sourceRetirementConflict?.paths.join()).toContain(workspace)

    if (restart) {
      await store.flushPendingOrThrowAsync()
      await closeTestStores()
      openStore()
    }
    await expect(retireChain()).rejects.toThrow('orcad_migration_retirement_conflict')
    expect(draftIn(workspace)).toBe('NEW draft during flush')
    // Its project stays too, so the draft is never orphaned.
    expect(store.getRepos().length + store.getFolderWorkspaces().length).toBe(1)
    expect(head()?.phase).toBe('destination-committed')
    expect(head()?.sourceRetirementConflict).toBeDefined()
  })

  it('retires an exact replay of the retired draft, clearing nothing it did not record', async () => {
    seedSource('repository')
    saveDraft(REPO_WORKTREE, 'committed draft', HOST_ID)
    await convertKeepingSource()
    writeDuringNextFlush(() => saveDraft(REPO_WORKTREE, 'committed draft'))
    await expect(retireChain()).resolves.toBe('retired')
    expect(draftIn(REPO_WORKTREE)).toBeUndefined()
    expect(store.getRepos()).toEqual([])
  })

  it.each([
    ['refuses, keeping a changed draft', 'changed after the attempt', 'skipped'],
    ['still retires an unchanged source', 'committed draft', 'retired']
  ])('with an earlier build’s start marker and no baseline, %s', async (_label, draft, outcome) => {
    seedSource('repository')
    saveDraft(REPO_WORKTREE, 'committed draft', HOST_ID)
    await convertKeepingSource()
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...head()!,
      sourceRetiringAt: '2026-10-04T00:00:00.000Z'
    })
    saveDraft(REPO_WORKTREE, draft, HOST_ID)
    await expect(retireChain()).resolves.toBe(outcome)
    if (outcome === 'skipped') {
      expect(draftIn(REPO_WORKTREE, HOST_ID)).toBe(draft)
      expect(head()?.sourceRetirementConflict?.paths).toEqual(['baseline-missing'])
    }
  })
})

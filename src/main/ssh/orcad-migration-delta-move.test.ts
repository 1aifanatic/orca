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
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import {
  listOrcadMigrationSourceCutovers,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { keepOrcadServerVersion, runOrcadDeltaMove } from './orcad-migration-delta-move'
import { planOrcadDeltaMove } from './orcad-migration-delta-plan'
import { reconcileManagedOrcadSshTargets, visibleRepos } from './orcad-retained-source'
import { retireRetainedOrcadSourceChain } from './orcad-retained-source-retirement'
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
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-delta-'))
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

/** Converted with source retirement off, then an older build adds repo-2 and renames repo-1. */
async function convertedThenChangedOnOlderBuild(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      listRelayPtyIds: async () => [],
      destinationFor: () => destination,
      releaseDirectSession: async () => {},
      now,
      retireSource: () => false
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
  store.addRepo(repo('repo-2', '/srv/tool'))
  store.updateRepo('repo-1', { displayName: 'app-renamed' })
  reconcileManagedOrcadSshTargets(userDataPath, store, now)
  expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
}

function deltaMove() {
  const target = store.getSshTarget(TARGET.id)!
  return runOrcadDeltaMove({
    userDataPath,
    store,
    claims: sshStore.getOrcadRuntimeClaims(),
    target,
    environment: listEnvironments(userDataPath)[0]!,
    destination,
    // This relay and every earlier-build relay answer that nothing runs.
    listRelayPtyIds: Object.assign(async () => [], { previous: async () => [] }),
    releaseDirectSession: async () => {},
    ensureTunnel: async () => {},
    runTargetLifecycle,
    now
  })
}

const LEAF = '11111111-1111-4111-8111-111111111111'

/** What v1.4.218 leaves after a downgrade: a terminal in what it added, and client focus there. */
function olderBuildSessionAfterDowngrade(): void {
  const hostId = `ssh:${TARGET.id}` as const
  const group = store.createProjectGroup({
    name: 'downgrade-added',
    parentPath: '/srv/folders',
    connectionId: TARGET.id,
    createdFrom: 'manual'
  })
  const folder = store.createFolderWorkspace({
    projectGroupId: group.id,
    name: 'downgrade-added workspace',
    folderPath: '/srv/folders/added',
    connectionId: TARGET.id
  })
  const folderKey = folderWorkspaceKey(folder.id)
  const environmentId = getManagedOrcadFenceEnvironmentId(store.getSshTarget(TARGET.id))!
  const focus: Partial<WorkspaceSessionState> = {
    activeRepoId: null,
    activeWorktreeId: folderKey,
    activeWorkspaceKey: folderKey,
    activeWorkspaceExecutionHostId: hostId,
    activeTabId: 'tab-term',
    activeConnectionIdsAtShutdown: [TARGET.id]
  }
  store.setWorkspaceSession({ ...store.getWorkspaceSession(), ...focus })
  store.setWorkspaceSession(
    {
      ...store.getWorkspaceSession(hostId),
      ...focus,
      tabsByWorktree: {
        [folderKey]: [
          {
            id: 'tab-term',
            ptyId: `${hostId}@@pty2:relay:1`,
            worktreeId: folderKey,
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
          ptyIdsByLeafId: { [LEAF]: `${hostId}@@pty2:relay:1` }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`tab-term:${LEAF}`]: 'incarnation-1' },
      terminalTopologyRevisionByRepoId: { [folderKey]: 1 },
      activeWorktreeIdsOnShutdown: [folderKey],
      unifiedTabs: {
        // The managed build stamped repo-1's editor tab with its server before the downgrade.
        'repo-1::/srv/app': [
          {
            id: 'tab-editor',
            entityId: '/srv/app/README.md',
            groupId: 'group-editor',
            worktreeId: 'repo-1::/srv/app',
            executionHostId: `runtime:${environmentId}`,
            contentType: 'editor',
            label: 'README.md',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    },
    hostId
  )
  store.upsertSshRemotePtyLease({
    targetId: TARGET.id,
    ptyId: 'pty2:relay:1',
    worktreeId: folderKey,
    tabId: 'tab-term',
    leafId: LEAF,
    state: 'expired'
  })
}

/** The delta's commit and every read after it fail, as when the tunnel drops mid-commit. */
function loseContactAtDeltaCommit(): () => void {
  const read = destination.readState.getMockImplementation()!
  let lost = false
  destination.commit.mockImplementationOnce(async () => {
    lost = true
    throw new Error('socket closed')
  })
  destination.readState.mockImplementation(async (manifest) => {
    if (lost) {
      throw new Error('socket closed')
    }
    return read(manifest)
  })
  return () => {
    lost = false
  }
}

describe('moving what an older build added to a converted host', () => {
  it('previews additions and what the server keeps, then moves only the additions', async () => {
    await convertedThenChangedOnOlderBuild()
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['repo-2'])
    expect(plan.notReflected.edited.map((row) => row.id)).toEqual(['repo-1'])
    expect(plan.notReflected.removed).toEqual([])

    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
    const journals = listOrcadMigrationSourceCutovers(userDataPath)
    const [first, delta] = [...journals].sort((a) => (a.supersedesMigrationId ? 1 : -1))
    expect(delta?.supersedesMigrationId).toBe(first?.migrationId)
    expect(delta?.manifest.payload.repositories.map((row) => row.id)).toEqual(['repo-2'])
    expect(journals.every((journal) => journal.sourceRetainedAt)).toBe(true)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
    // Back to managed, and a start with nothing new keeps it there.
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  it('fails the whole delta when the server already holds a colliding row', async () => {
    await convertedThenChangedOnOlderBuild()
    destination.stage.mockRejectedValueOnce(
      new Error('orcad_migration_repository_id_conflict:repo-2')
    )
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_delta_refused_by_server',
      reason: 'orcad_migration_repository_id_conflict:repo-2'
    })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    expect(
      visibleRepos(store, () => userDataPath)
        .map((row) => row.id)
        .sort()
    ).toEqual(['repo-1', 'repo-2'])
  })

  it('keeps the server version: back to managed, the older build changes stay unshown', async () => {
    await convertedThenChangedOnOlderBuild()
    await keepOrcadServerVersion({
      userDataPath,
      store,
      claims: sshStore.getOrcadRuntimeClaims(),
      target: store.getSshTarget(TARGET.id)!
    })
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    expect(destination.commits).toBe(1)
  })

  it('retires both manifests once retirement is on, never before the delta commits', async () => {
    await convertedThenChangedOnOlderBuild()
    const target = () => store.getSshTarget(TARGET.id)!
    const lifecycle = <T>(_id: string, run: () => Promise<T>) => run()
    // Changed and not yet moved: nothing retires.
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, target(), lifecycle)
    ).resolves.toBe('skipped')
    expect(store.getRepos()).toHaveLength(2)

    await deltaMove()
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, target(), lifecycle)
    ).resolves.toBe('retired')
    expect(store.getRepos()).toEqual([])
    expect(getManagedOrcadFenceEnvironmentId(target())).toBe(listEnvironments(userDataPath)[0]?.id)
  })

  it('survives a second downgrade and re-upgrade after the delta move', async () => {
    await convertedThenChangedOnOlderBuild()
    await deltaMove()
    // A second trip to an older build adds another project.
    store.addRepo(repo('repo-3', '/srv/docs'))
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.added.map((row) => row.id)).toEqual(['repo-3'])
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(3)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(3)
    expect(visibleRepos(store, () => userDataPath)).toEqual([])
  })

  it('moves what a downgrade added despite its exited terminal, tabs and client focus', async () => {
    await convertedThenChangedOnOlderBuild()
    olderBuildSessionAfterDowngrade()
    await store.upsertSshPtyConsumerRecovery({
      targetId: TARGET.id,
      clientInstanceId: 'client-1',
      serverBuildId: '0.1.0',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'lease'
    })
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    const plan = planOrcadDeltaMove(userDataPath, store, store.getSshTarget(TARGET.id)!)
    expect(plan.blockers).toEqual([])
    expect(plan.added.map((row) => row.kind).sort()).toEqual([
      'folder-workspace',
      'project-group',
      'repository'
    ])
    // The relay answers with no terminals, so the expired lease is proven exited.
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    const delta = listOrcadMigrationSourceCutovers(userDataPath).find(
      (journal) => journal.supersedesMigrationId
    )
    const session = delta?.manifest.payload.dormantState?.workspaceSession
    expect(Object.values(session?.tabsByWorktree ?? {}).flat()).toMatchObject([
      { id: 'tab-term', ptyId: null }
    ])
    expect(session?.unifiedTabs?.['repo-1::/srv/app']).toBeUndefined()
  })

  it('resumes a delta whose commit lost contact, keeping the host marked meanwhile', async () => {
    await convertedThenChangedOnOlderBuild()
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()

    reconnect()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
  })

  it('backs out an interrupted delta the source has since outgrown, then moves afresh', async () => {
    await convertedThenChangedOnOlderBuild()
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    reconnect()
    await expect(
      keepOrcadServerVersion({
        userDataPath,
        store,
        claims: sshStore.getOrcadRuntimeClaims(),
        target: store.getSshTarget(TARGET.id)!
      })
    ).rejects.toThrow('orcad_delta_move_unfinished')

    store.addRepo(repo('repo-3', '/srv/docs'))
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'orcad_migration_source_changed'
    })
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
    expect(destination.commits).toBe(2)
  })

  it('refuses a delta whose source changes while it stages', async () => {
    await convertedThenChangedOnOlderBuild()
    const stage = destination.stage.getMockImplementation()!
    destination.stage.mockImplementationOnce(async (manifest) => {
      store.addRepo(repo('repo-3', '/srv/docs'))
      return stage(manifest)
    })
    await expect(deltaMove()).resolves.toMatchObject({
      outcome: 'refused',
      reason: 'orcad_migration_source_changed'
    })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(1)
  })

  it('runs one of two concurrent moves; the other finds it superseded', async () => {
    await convertedThenChangedOnOlderBuild()
    const results = await Promise.all([deltaMove(), deltaMove()])
    expect(results.map((result) => result.outcome).sort()).toEqual(['moved', 'refused'])
    expect(destination.commits).toBe(2)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toHaveLength(2)
  })

  it('gives a delta a crash interrupted its mark back on the next start', async () => {
    await convertedThenChangedOnOlderBuild()
    const reconnect = loseContactAtDeltaCommit()
    await expect(deltaMove()).rejects.toThrow('socket closed')
    reconnect()
    // What a crash before the mark came back leaves: the delta journal, a fence without its mark.
    const environmentId = store.getSshTarget(TARGET.id)!.orcadFence!.environmentId
    store.updateSshTarget(TARGET.id, { orcadFence: { environmentId } })
    expect(visibleRepos(store, () => userDataPath)).toHaveLength(2)
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(deltaMove()).resolves.toMatchObject({ outcome: 'moved' })
  })

  it('retires a moved project with metadata an older build added to it', async () => {
    await convertedThenChangedOnOlderBuild()
    store.setWorktreeMetaForHost('repo-1::/srv/app-feature', `ssh:${TARGET.id}`, {
      displayName: 'feature'
    })
    await deltaMove()
    const lifecycle = <T>(_id: string, run: () => Promise<T>) => run()
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, store.getSshTarget(TARGET.id)!, lifecycle)
    ).resolves.toBe('retired')
    expect(store.getAllWorktreeMetaForHost(`ssh:${TARGET.id}`)).toEqual({})
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
  })

  it('resumes a retirement that failed after deleting rows, never reading it as changed', async () => {
    await convertedThenChangedOnOlderBuild()
    await deltaMove()
    const lifecycle = <T>(_id: string, run: () => Promise<T>) => run()
    const target = () => store.getSshTarget(TARGET.id)!
    vi.spyOn(store, 'flushPendingOrThrowAsync').mockRejectedValueOnce(new Error('disk full'))
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, target(), lifecycle)
    ).rejects.toThrow('disk full')
    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    expect(target().orcadFence?.sourceChangedAt).toBeUndefined()
    await expect(
      retireRetainedOrcadSourceChain(userDataPath, store, target(), lifecycle)
    ).resolves.toBe('retired')
    expect(store.getRepos()).toEqual([])
  })
})

const HOST_ID = `ssh:${TARGET.id}` as const

/** An unsaved editor draft in the host's session partition, as either build would save it. */
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

async function convertKeepingSource(): Promise<void> {
  await expect(
    convertSshTargetToManagedOrcad(userDataPath, {
      sshTargetId: TARGET.id,
      name: 'Managed',
      listRelayPtyIds: async () => [],
      destinationFor: () => destination,
      releaseDirectSession: async () => {},
      now,
      retireSource: () => false
    })
  ).resolves.toMatchObject({ outcome: 'converted' })
}

const retireChain = () =>
  retireRetainedOrcadSourceChain(userDataPath, store, store.getSshTarget(TARGET.id)!, (_id, run) =>
    run()
  )

describe('a draft an older build edited in a retained source', () => {
  it.each([
    ['a repository worktree', () => 'repo-1::/srv/app'],
    [
      'a folder workspace on a folder-only host',
      () => {
        store.removeProject('repo-1')
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
  ])('in %s marks the host changed and is never retired', async (_label, workspace) => {
    const worktreeId = workspace()
    saveDraft(worktreeId, 'draft before migration')
    await convertKeepingSource()
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.sourceStateFingerprint).toBeDefined()

    // The older build edits only the draft: no project is added, removed or renamed.
    saveDraft(worktreeId, 'draft after downgrade')
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(retireChain()).resolves.toBe('skipped')
    expect(savedDraft(worktreeId)).toBe('draft after downgrade')
  })

  it('marks the host changed when an older build edits an automation it keeps', async () => {
    const automation = store.createAutomation({
      name: 'Nightly',
      prompt: 'Run checks',
      agentId: 'claude',
      projectId: 'repo-1',
      workspaceMode: 'new_per_run',
      baseBranch: null,
      timezone: 'UTC',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      dtstart: new Date('2026-10-01T00:00:00Z').getTime(),
      // Only a paused automation moves: a running scheduler cannot hand over mid-flight.
      enabled: false
    })
    await convertKeepingSource()

    store.updateAutomation(
      automation.id,
      { prompt: 'Run checks, then open a PR' },
      {
        expectedOwner: {
          selector: {
            kind: 'ssh',
            targetId: TARGET.id,
            targetGeneration: store.getSshTarget(TARGET.id)!.generation!
          }
        }
      }
    )
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeDefined()
    await expect(retireChain()).resolves.toBe('skipped')
  })

  it('leaves an unchanged retained source hidden and retires it', async () => {
    saveDraft('repo-1::/srv/app', 'draft before migration')
    await convertKeepingSource()
    reconcileManagedOrcadSshTargets(userDataPath, store, now)

    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    await expect(retireChain()).resolves.toBe('retired')
  })

  it('never auto-retires a legacy journal that has no state baseline', async () => {
    saveDraft('repo-1::/srv/app', 'draft before migration')
    await convertKeepingSource()
    const [journal] = listOrcadMigrationSourceCutovers(userDataPath)
    const { sourceStateFingerprint: _dropped, ...legacy } = journal!
    writeOrcadMigrationSourceCutover(userDataPath, legacy)
    saveDraft('repo-1::/srv/app', 'draft after downgrade')

    reconcileManagedOrcadSshTargets(userDataPath, store, now)
    // Unverified, not changed: it stays hidden as before, and its state is kept.
    expect(store.getSshTarget(TARGET.id)?.orcadFence?.sourceChangedAt).toBeUndefined()
    await expect(retireChain()).resolves.toBe('skipped')
    expect(savedDraft('repo-1::/srv/app')).toBe('draft after downgrade')
  })
})

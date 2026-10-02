import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { addManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { fakeOrcadMigrationDestination } from './orcad-migration-destination-fake'
import { SshConnectionStore } from './ssh-connection-store'

const mocks = vi.hoisted(() => {
  const state: { targetStore: unknown } = { targetStore: null }
  return { state, deploy: vi.fn(), ensureTunnel: vi.fn(), directAuthority: vi.fn() }
})
vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({}),
  getSshTargetRegistryStore: () => mocks.state.targetStore,
  hasRegisteredDirectSshAuthority: mocks.directAuthority
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
let destination: ReturnType<typeof fakeOrcadMigrationDestination>

beforeEach(() => {
  vi.resetAllMocks()
  userDataPath = mkdtempSync(join(tmpdir(), 'orcad-conversion-'))
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
  mocks.directAuthority.mockReturnValue(false)
  mocks.ensureTunnel.mockResolvedValue(undefined)
  // Registers the server the fence named, as the real deploy would after pairing.
  mocks.deploy.mockImplementation(async (path: string, args: { name: string }) => {
    const owner = getManagedOrcadOwnerEnvironmentId(store.getSshTarget(TARGET.id)?.owner)
    if (!owner) {
      throw new Error('deploy without a fence')
    }
    if (!listEnvironments(path).some((entry) => entry.id === owner)) {
      addManagedOrcadEnvironment(path, {
        id: owner,
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

const releaseDirectSession = vi.fn(async () => {})
const convert = (listRelayPtyIds: (() => Promise<string[] | null>) | null = async () => []) =>
  convertSshTargetToManagedOrcad(userDataPath, {
    sshTargetId: TARGET.id,
    name: 'Managed',
    listRelayPtyIds,
    destinationFor: () => destination,
    releaseDirectSession,
    now: () => new Date('2026-10-02T00:00:00.000Z')
  })

describe('converting an SSH host into a managed server', () => {
  it('fences, deploys, marks the server, commits once, then retires the source', async () => {
    const result = await convert()
    expect(result).toMatchObject({ outcome: 'converted' })
    expect(releaseDirectSession).toHaveBeenCalledWith(TARGET.id)
    expect(mocks.deploy).toHaveBeenCalledWith(
      userDataPath,
      expect.objectContaining({ migration: true })
    )
    const [environment] = listEnvironments(userDataPath)
    expect(environment?.orcadMigratedAt).toBe('2026-10-02T00:00:00.000Z')
    expect(destination.commits).toBe(1)
    expect(store.getRepos()).toEqual([])
    // The journal compacts once the server matches it; the fenced target stays for the tunnel.
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
    expect(getManagedOrcadOwnerEnvironmentId(store.getSshTarget(TARGET.id)?.owner)).toBe(
      environment?.id
    )
    await expect(convert()).resolves.toMatchObject({
      outcome: 'refused',
      code: 'orcad_migration_already_managed'
    })
  })

  it('refuses before touching the host while terminals run or cannot be counted', async () => {
    store.upsertSshRemotePtyLease({ targetId: TARGET.id, ptyId: 'p', state: 'expired' })
    await expect(convert(null)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(releaseDirectSession).not.toHaveBeenCalled()
    expect(store.getSshTarget(TARGET.id)?.owner).toBeUndefined()
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
  })

  it('keeps the fence across a deferred deploy and resumes the same migration', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'deferred',
      candidateVersion: '1.0.0',
      code: 'orcad_update_terminals_running',
      reason: 'busy'
    })
    await expect(convert()).resolves.toMatchObject({ outcome: 'deferred' })
    const [fenced] = listOrcadMigrationSourceCutovers(userDataPath)
    expect(fenced?.phase).toBe('source-fenced')
    await expect(convert(null)).resolves.toMatchObject({
      outcome: 'converted',
      migrationId: fenced?.migrationId
    })
    expect(destination.commits).toBe(1)
  })

  it('resumes after a lost commit reply without committing twice', async () => {
    const read = destination.readState.getMockImplementation()
    const commit = destination.commit.getMockImplementation()
    let reachable = true
    destination.readState.mockImplementation(async (manifest) => {
      if (!reachable) {
        throw new Error('socket closed')
      }
      return read!(manifest)
    })
    // The commit lands, then contact is lost before either the reply or a re-read arrives.
    destination.commit.mockImplementationOnce(async (manifest) => {
      await commit!(manifest)
      reachable = false
      throw new Error('socket closed')
    })
    await expect(convert()).rejects.toThrow('socket closed')
    expect(listOrcadMigrationSourceCutovers(userDataPath)[0]?.phase).toBe('destination-staged')
    reachable = true
    await expect(convert(null)).resolves.toMatchObject({ outcome: 'converted' })
    expect(destination.commits).toBe(1)
    expect(listOrcadMigrationSourceCutovers(userDataPath)).toEqual([])
    expect(store.getRepos()).toEqual([])
  })
})

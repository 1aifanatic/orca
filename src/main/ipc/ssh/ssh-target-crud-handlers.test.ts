import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import type * as SshTargetRegistry from '../../ssh/targets/ssh-target-registry'

const mocks = vi.hoisted(() => ({
  targets: new Map<string, SshTarget>(),
  savedIds: vi.fn<() => Promise<Set<string> | null>>(),
  pendingMigrations: vi.fn<() => { sshTargetId: string }[]>(() => [])
}))

vi.mock('../../ssh/targets/ssh-target-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof SshTargetRegistry>()),
  getSshTargetRegistryStore: () => ({
    getTarget: (id: string) => mocks.targets.get(id),
    removeTarget: (id: string) => mocks.targets.delete(id)
  })
}))
vi.mock('../../ssh/host-server/ssh-host-server-status', () => ({
  clearSshHostServerStatus: vi.fn()
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: vi.fn(async () => undefined),
  closeOrcadManagedTunnelsForTarget: vi.fn(async () => undefined)
}))
vi.mock('./ssh-renderer-broadcast', () => ({ broadcastSshTargetRemoved: vi.fn() }))
vi.mock('../../ssh/application/ssh-desktop-host', () => ({
  sshDesktopHost: () => ({ clearTargetBrowserStorage: vi.fn(async () => undefined) })
}))
vi.mock('../browser/desktop-browser-bridge-reconcile', () => ({
  requestDesktopBrowserBridgeReconcile: vi.fn(),
  setDesktopBrowserBridgeHostStopped: vi.fn()
}))
vi.mock('../runtime-environments/catalog/runtime-environment-saved-ids', () => ({
  readSavedRuntimeEnvironmentIds: mocks.savedIds
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-migration-status', () => ({
  listPendingManagedOrcadMigrations: mocks.pendingMigrations
}))
vi.mock('../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/user-data' })
}))

import { getRegisteredSshTargetMutations } from '../../ssh/targets/ssh-target-registry'
import { registerSshTargetCrudHandlers } from './ssh-target-crud-handlers'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

const MANAGED_HOST_REFUSAL = /Orca runs on this host/

function seedClaimedTarget(environmentId: string): void {
  mocks.targets.set('ssh-1', {
    id: 'ssh-1',
    label: 'box',
    host: 'box',
    port: 22,
    username: '',
    orcadFence: { environmentId },
    orcadProvisioning: { requestId: environmentId, name: 'box' }
  })
}

const remove = (): Promise<void> => getRegisteredSshTargetMutations().remove('ssh-1')

describe('removing an SSH host that a managed server claim names', () => {
  beforeEach(() => {
    mocks.targets.clear()
    mocks.savedIds.mockReset()
    mocks.pendingMigrations.mockReset().mockReturnValue([])
    registerSshTargetCrudHandlers(vi.fn())
  })

  it('removes the host when the claimed server is no longer saved', async () => {
    seedClaimedTarget('gone-env')
    mocks.savedIds.mockResolvedValue(new Set(['other-env']))

    await remove()

    expect(mocks.targets.has('ssh-1')).toBe(false)
  })

  it.each([
    ['the claimed server is saved', new Set(['gone-env'])],
    ['the saved servers cannot be read', null]
  ])('keeps the host when %s', async (_case, saved) => {
    seedClaimedTarget('gone-env')
    mocks.savedIds.mockResolvedValue(saved)

    await expect(remove()).rejects.toThrow(MANAGED_HOST_REFUSAL)
    expect(mocks.targets.has('ssh-1')).toBe(true)
  })

  it.each([
    ['a move to its server is pending', () => [{ sshTargetId: 'ssh-1' }]],
    [
      'the migration journal cannot be read',
      () => {
        throw new Error('unreadable journal')
      }
    ]
  ])('keeps the host while %s', async (_case, pending) => {
    seedClaimedTarget('gone-env')
    mocks.savedIds.mockResolvedValue(new Set())
    mocks.pendingMigrations.mockImplementation(pending)

    await expect(remove()).rejects.toThrow(MANAGED_HOST_REFUSAL)
    expect(mocks.targets.has('ssh-1')).toBe(true)
  })

  it('keeps a direct host that a deploy queued ahead of the removal claims', async () => {
    mocks.targets.set('ssh-1', { id: 'ssh-1', label: 'box', host: 'box', port: 22, username: '' })
    mocks.savedIds.mockResolvedValue(new Set(['new-env']))
    let finishDeploy!: () => void
    const deploy = runTargetLifecycle('ssh-1', async () => {
      await new Promise<void>((resolve) => (finishDeploy = resolve))
      seedClaimedTarget('new-env')
    })

    const removal = remove()
    finishDeploy()
    await deploy
    await expect(removal).rejects.toThrow(MANAGED_HOST_REFUSAL)
    expect(mocks.targets.has('ssh-1')).toBe(true)
  })

  it('refuses at once while a deploy holds the host', async () => {
    seedClaimedTarget('new-env')
    mocks.savedIds.mockResolvedValue(new Set())
    let finishDeploy!: () => void
    const deploy = runTargetLifecycle('ssh-1', async () => {
      await new Promise<void>((resolve) => (finishDeploy = resolve))
    })

    await expect(remove()).rejects.toThrow(MANAGED_HOST_REFUSAL)
    expect(mocks.savedIds).not.toHaveBeenCalled()
    finishDeploy()
    await deploy
    expect(mocks.targets.has('ssh-1')).toBe(true)
  })
})

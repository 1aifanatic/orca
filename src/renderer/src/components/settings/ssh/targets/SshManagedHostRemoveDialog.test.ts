import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { refusesManagedSshHostRemoval } from './SshManagedHostRemoveDialog'

const managedHost = {
  orcadFence: { environmentId: 'env-1' },
  orcadProvisioning: { requestId: 'env-1', name: 'box' }
}

function loadCatalog(hydrated: boolean, ids: string[]): void {
  useAppStore.setState({
    runtimeEnvironmentCatalogHydrated: hydrated,
    runtimeEnvironments: ids.map((id): PublicKnownRuntimeEnvironment => ({
      id,
      name: id,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      endpoints: [{ id: 'ws', kind: 'websocket', label: 'ws', endpoint: 'ws://127.0.0.1:1' }],
      preferredEndpointId: 'ws'
    }))
  })
}

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('lets removal reach main when the loaded catalog has no server for the claim', () => {
  loadCatalog(true, ['other-env'])
  expect(refusesManagedSshHostRemoval(managedHost, false)).toBe(false)
})

it('keeps the managed-host dialog while the server is listed or the catalog is not loaded', () => {
  loadCatalog(true, ['env-1'])
  expect(refusesManagedSshHostRemoval(managedHost, false)).toBe(true)
  loadCatalog(false, [])
  expect(refusesManagedSshHostRemoval(managedHost, false)).toBe(true)
})

it('keeps the managed-host dialog while a conversion still owns direct workspaces', () => {
  loadCatalog(true, ['other-env'])
  expect(refusesManagedSshHostRemoval(managedHost, true)).toBe(true)
})

it('never refuses a direct SSH host', () => {
  loadCatalog(false, [])
  expect(refusesManagedSshHostRemoval({}, true)).toBe(false)
})

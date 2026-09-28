import { afterEach, expect, it, vi } from 'vitest'
import { bindProviderListeners } from './bind-listeners'
import { setRebindProviderListeners, unbindLocalProviderListeners } from './listener-lifecycle'
import {
  getLocalPtyProvider,
  setLocalPtyProvider,
  registerWslPtyProvider,
  registerSshPtyProvider,
  unregisterSshPtyProvider
} from './registry'
import { createUnavailablePtyProvider } from '../../../providers/unavailable-pty-provider'
import type { IPtyProvider } from '../../../providers/types'

const original = getLocalPtyProvider()
const releases: (() => void)[] = []
afterEach(() => {
  setRebindProviderListeners(null)
  unbindLocalProviderListeners()
  releases.splice(0).forEach((release) => release())
  unregisterSshPtyProvider('remote')
  setLocalPtyProvider(original)
})
function provider() {
  const listeners = new Set<Parameters<IPtyProvider['onData']>[0]>()
  return {
    value: {
      ...createUnavailablePtyProvider(),
      onData(listener: Parameters<IPtyProvider['onData']>[0]) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    listeners,
    emit: (id: string) => listeners.forEach((listener) => listener({ id, data: 'output' }))
  }
}
it('binds added guests once, excludes SSH and removes listeners across reload and disconnect', () => {
  const native = provider(),
    guest = provider(),
    remote = provider()
  setLocalPtyProvider(native.value)
  registerSshPtyProvider('remote', remote.value)
  const session = {
    acceptPtyDataForRenderer: vi.fn(),
    sendModelRestoreNeededMarker: vi.fn(),
    consumeSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer: vi.fn()
  }
  setRebindProviderListeners(() => bindProviderListeners(session))
  bindProviderListeners(session)
  const release = registerWslPtyProvider({ distro: 'Ubuntu', relayBuildId: 'owner' }, guest.value)
  releases.push(release)
  bindProviderListeners(session)
  expect(native.listeners.size).toBe(1)
  expect(guest.listeners.size).toBe(1)
  expect(remote.listeners.size).toBe(0)
  native.emit('native')
  guest.emit('guest')
  expect(session.acceptPtyDataForRenderer).toHaveBeenCalledTimes(2)
  release()
  expect(guest.listeners.size).toBe(0)
  expect(native.listeners.size).toBe(1)
  guest.emit('retired')
  expect(session.acceptPtyDataForRenderer).toHaveBeenCalledTimes(2)
  unbindLocalProviderListeners()
  expect(native.listeners.size).toBe(0)
})

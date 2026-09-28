import {
  isDaemonRestartInFlight,
  runCoalescedDaemonRestart
} from '../../../daemon/daemon-restart-state'
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

it('does not rebind a retiring local provider when guests change during restart', async () => {
  const rebind = vi.fn()
  setRebindProviderListeners(rebind)
  let finish!: () => void
  const pending = runCoalescedDaemonRestart(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { killedCount: 0 }
  })
  try {
    const release = registerWslPtyProvider(
      { distro: 'Ubuntu', relayBuildId: 'during-restart' },
      provider().value
    )
    releases.push(release)
    release()
    expect(rebind).not.toHaveBeenCalled()
  } finally {
    finish()
    await pending
  }
  expect(rebind).toHaveBeenCalledOnce()
  rebind.mockClear()
  releases.push(
    registerWslPtyProvider({ distro: 'Ubuntu', relayBuildId: 'after-restart' }, provider().value)
  )
  expect(rebind).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'binds a guest arriving after the final rebind but before restart settles (failed=%s)',
  async (failed) => {
    const native = provider(),
      guest = provider()
    setLocalPtyProvider(native.value)
    const session = {
      acceptPtyDataForRenderer: vi.fn(),
      sendModelRestoreNeededMarker: vi.fn(),
      consumeSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
    const rebind = vi.fn(() => bindProviderListeners(session))
    setRebindProviderListeners(rebind)
    let lateRegistered = false
    const pending = runCoalescedDaemonRestart(async () => {
      await Promise.resolve()
      rebind()
      queueMicrotask(() => {
        expect(isDaemonRestartInFlight()).toBe(true)
        releases.push(
          registerWslPtyProvider({ distro: 'Ubuntu', relayBuildId: 'late' }, guest.value)
        )
        expect(guest.listeners.size).toBe(0)
        lateRegistered = true
      })
      if (failed) {
        throw new Error('restart failed')
      }
      return { killedCount: 0 }
    })
    await (failed ? expect(pending).rejects.toThrow('restart failed') : pending)
    await vi.waitFor(() => expect(guest.listeners.size).toBe(1))
    expect(lateRegistered).toBe(true)
    expect(native.listeners.size).toBe(1)
    guest.emit('guest')
    expect(session.acceptPtyDataForRenderer).toHaveBeenCalledOnce()
    expect(rebind).toHaveBeenCalledTimes(2)
  }
)

it('rebinds once after a failed restart with registrations and removals in flight', async () => {
  const rebind = vi.fn()
  setRebindProviderListeners(rebind)
  let fail!: (error: Error) => void
  const pending = runCoalescedDaemonRestart(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      })
  )
  const rejection = expect(pending).rejects.toThrow('failed')
  const release = registerWslPtyProvider(
    { distro: 'Ubuntu', relayBuildId: 'failed' },
    provider().value
  )
  releases.push(release)
  release()
  releases.push(
    registerWslPtyProvider({ distro: 'Ubuntu', relayBuildId: 'survivor' }, provider().value)
  )
  expect(rebind).not.toHaveBeenCalled()
  fail(new Error('failed'))
  await rejection
  await vi.waitFor(() => expect(rebind).toHaveBeenCalledOnce())
})

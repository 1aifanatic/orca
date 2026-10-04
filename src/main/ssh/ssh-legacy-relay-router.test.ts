import { describe, expect, it, vi } from 'vitest'
import type { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshLegacyRelayRoute } from './ssh-legacy-relay-route'
import { SshLegacyRelayRouter } from './ssh-legacy-relay-router'

const OLD_SOCK = '/home/dev/.orca-remote/relay-0.1.0+old/relay-abc.sock'
const HELD = 'ssh:target-1@@pty2:old:1'

function fakeRoute(listed: string[]) {
  const served = new Set<string>()
  const closeListeners: (() => void)[] = []
  // Only identity matters here; the router never calls into the provider itself.
  const provider: SshPtyProvider = Object.create(null)
  const route = {
    provider,
    heldPtyIds: () => [...listed],
    holds: (id: string) => listed.includes(id),
    serves: (id: string) => served.has(id),
    get servesAny() {
      return served.size > 0
    },
    beginServing: (id: string) => served.add(id),
    stopServing: (id: string) => served.delete(id),
    onClose: (listener: () => void) => closeListeners.push(listener),
    close: vi.fn(() => closeListeners.forEach((listener) => listener()))
  }
  return route
}

function routerFor(route: ReturnType<typeof fakeRoute> | null, endpoints = [OLD_SOCK]) {
  const openRoute = vi.fn(async (): Promise<SshLegacyRelayRoute | null> => {
    // The router reads only the members the fake implements; setPrototypeOf keeps its getter live.
    const opened: SshLegacyRelayRoute | null =
      route && Object.setPrototypeOf(route, Object.prototype)
    return opened
  })
  return {
    openRoute,
    router: new SshLegacyRelayRouter({
      targetId: 'target-1',
      endpoints: async () => endpoints,
      openRoute
    })
  }
}

describe('SshLegacyRelayRouter', () => {
  it('serves a held PTY through the older relay that lists it', async () => {
    const route = fakeRoute([HELD])
    const { router } = routerFor(route)

    const served = await router.attach(HELD)

    expect(served?.provider).toBe(route.provider)
    expect(router.providerFor(HELD)).toBe(route.provider)
    expect(router.providerFor('ssh:target-1@@pty2:new:1')).toBeUndefined()
    expect(router.servedProviders()).toEqual([route.provider])
  })

  it('hangs up a route that holds none of the requested terminals', async () => {
    const route = fakeRoute(['ssh:target-1@@pty2:old:2'])
    const { router } = routerFor(route)

    await expect(router.attach(HELD)).resolves.toBeNull()
    expect(route.close).toHaveBeenCalledWith('legacy-relay-holds-no-requested-terminal')
  })

  it('releases the route when the attach through it fails', async () => {
    const route = fakeRoute([HELD])
    const { router } = routerFor(route)

    const served = await router.attach(HELD)
    served?.release()

    expect(router.providerFor(HELD)).toBeUndefined()
    expect(route.close).toHaveBeenCalledWith('legacy-relay-attach-abandoned')
  })

  it('leaves the pane held when the older relay cannot be bridged or reached', async () => {
    await expect(routerFor(null).router.attach(HELD)).resolves.toBeNull()

    const failing = new SshLegacyRelayRouter({
      targetId: 'target-1',
      endpoints: async () => [OLD_SOCK],
      openRoute: async () => {
        throw new Error('bridge exited before ready')
      }
    })
    await expect(failing.attach(HELD)).resolves.toBeNull()
  })

  it('opens one bridge per endpoint for concurrent attaches', async () => {
    const route = fakeRoute([HELD, 'ssh:target-1@@pty2:old:2'])
    const { router, openRoute } = routerFor(route)

    await Promise.all([router.attach(HELD), router.attach('ssh:target-1@@pty2:old:2')])

    expect(openRoute).toHaveBeenCalledTimes(1)
  })

  it('closes every route on dispose', async () => {
    const route = fakeRoute([HELD])
    const { router } = routerFor(route)
    await router.attach(HELD)

    router.dispose()

    expect(route.close).toHaveBeenCalledWith('legacy-relay-router-disposed')
    expect(router.providerFor(HELD)).toBeUndefined()
  })

  it('lists what older relays hold for the terminal gate, then hangs up unserved routes', async () => {
    const route = fakeRoute([HELD])
    const { router } = routerFor(route)

    await expect(router.listHeld()).resolves.toEqual([HELD])
    expect(route.close).toHaveBeenCalledWith('legacy-relay-listed-for-terminal-gate')
  })

  it('answers null, never empty, when an older relay cannot be asked', async () => {
    const { router } = routerFor(null)

    await expect(router.listHeld()).resolves.toBeNull()
    await expect(routerFor(null, []).router.listHeld()).resolves.toEqual([])
  })
})

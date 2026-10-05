import { describe, expect, it, vi } from 'vitest'

const { exitListeners } = vi.hoisted(() => {
  const listeners: ((payload: { id: string }) => void)[] = []
  return { exitListeners: listeners }
})

vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class {
    onDispose = vi.fn()
    dispose = vi.fn()
    isDisposed = vi.fn(() => false)
  }
}))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(async () => ({}))
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  allocateSshPtyProviderGeneration: vi.fn(() => 41),
  closeSshPtyOutputGeneration: vi.fn()
}))
vi.mock('../ipc/pty/provider/registry', () => ({ sshProvidersByGeneration: new Map() }))
vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class {
    providerGeneration = 41
    onData = vi.fn()
    onReplay = vi.fn()
    onExit = (listener: (payload: { id: string }) => void) => exitListeners.push(listener)
    listProcesses = vi.fn(async () => [{ id: SERVED }, { id: UNSERVED }])
    dispose = vi.fn()
  }
}))

import { legacyRelayBridge, SshLegacyRelayRoute } from './ssh-legacy-relay-route'

const SERVED = 'ssh:target-1@@pty2:old:1'
const UNSERVED = 'ssh:target-1@@pty2:old:2'

describe('legacyRelayBridge', () => {
  it("runs the old build's own bridge from its version directory", () => {
    const bridge = legacyRelayBridge(
      '/usr/bin/node',
      '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock'
    )

    expect(bridge).toEqual({
      relayDir: '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122',
      connectCommand:
        "cd '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122' && '/usr/bin/node' relay.js --connect " +
        "--sock-path '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock' " +
        "--credential-file '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock.credential'",
      versionCommand: "cat '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122'/.version"
    })
  })

  it('declines an endpoint that does not sit in its own version directory', () => {
    expect(
      legacyRelayBridge('/usr/bin/node', '/tmp/.orca-relay-1000/relay-1a2b/relay-92ff.sock')
    ).toBeNull()
    expect(legacyRelayBridge('/usr/bin/node', '/home/dev/.orca-remote/relay-92ff.sock')).toBeNull()
  })
})

describe('SshLegacyRelayRoute', () => {
  it('stops holding an unserved PTY that exits, while it keeps serving another', async () => {
    const sink = { data: vi.fn(), exit: vi.fn(), replay: vi.fn() }
    const route = await SshLegacyRelayRoute.open({
      targetId: 'target-1',
      sockPath: '/home/dev/.orca-remote/relay-0.1.0+f6e4b640b122/relay-92ff.sock',
      nodePath: '/usr/bin/node',
      clientInstanceId: 'this-build',
      openTransport: vi.fn(),
      readText: vi.fn(async () => '0.1.0+f6e4b640b122\n'),
      sink
    })
    route!.beginServing(SERVED)

    for (const listener of exitListeners) {
      listener({ id: UNSERVED })
    }

    expect(route!.heldPtyIds()).toEqual([SERVED])
    expect(route!.holds(UNSERVED)).toBe(false)
    expect(route!.serves(SERVED)).toBe(true)
    expect(sink.exit).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { legacyRelayBridge } from './ssh-legacy-relay-route'

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

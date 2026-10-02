import { describe, expect, it } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { getLegacyDaemonProtocolVersionForPty } from './daemon-provider-routing'
import { PROTOCOL_VERSION } from './daemon-protocol-version'
import { LocalPtyProvider } from '../providers/local-pty-provider'

describe('getLegacyDaemonProtocolVersionForPty', () => {
  const router = new DaemonPtyRouter({
    current: createAdapter('current', ['fresh'], undefined, PROTOCOL_VERSION),
    legacy: [createAdapter('v36', ['old'], undefined, 36)]
  })

  it('names the protocol of the older daemon still serving a PTY', () => {
    expect(getLegacyDaemonProtocolVersionForPty(router, 'old')).toBe(36)
  })

  it("reads null for a PTY on this build's daemon", () => {
    expect(getLegacyDaemonProtocolVersionForPty(router, 'fresh')).toBeNull()
  })

  it('reads null for the in-process fallback provider, which has no daemon', () => {
    expect(getLegacyDaemonProtocolVersionForPty(new LocalPtyProvider(), 'old')).toBeNull()
  })
})

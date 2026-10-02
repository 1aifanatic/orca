import { describe, expect, it } from 'vitest'
import { createAdapter } from './daemon-pty-router-test-fixture'
import { DaemonPtyRouter } from './daemon-pty-router'
import { getLegacyDaemonAdapters } from './daemon-provider-routing'
import { LocalPtyProvider } from '../providers/local-pty-provider'

describe('getLegacyDaemonAdapters', () => {
  it("lists the older daemons a router keeps, not this build's", () => {
    const current = createAdapter('current')
    const legacy = createAdapter('v36', [], undefined, 36)
    expect(getLegacyDaemonAdapters(new DaemonPtyRouter({ current, legacy: [legacy] }))).toEqual([
      legacy
    ])
  })

  it('lists none for a lone daemon or the in-process fallback provider', () => {
    expect(getLegacyDaemonAdapters(createAdapter('current'))).toEqual([])
    expect(getLegacyDaemonAdapters(new LocalPtyProvider())).toEqual([])
  })
})

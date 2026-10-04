import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type { RelayEndpointIncumbent } from './ssh-relay-endpoint-incumbent'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { execCommand, probeRelayEndpointIncumbent } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  probeRelayEndpointIncumbent: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))
vi.mock('./ssh-relay-endpoint-incumbent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  probeRelayEndpointIncumbent
}))

import {
  censusPreviousRelays,
  clearPreviousRelayCensus,
  isReattachHeldByPreviousRelay,
  mayHoldTerminals,
  previousRelayCensus,
  startPreviousRelayCensus
} from './ssh-previous-relay-terminals'

// The census only hands the connection to the mocked exec and probe.
const conn: SshConnection = Object.create(null)
const OLD_SOCK = '/home/dev/.orca-remote/relay-0.1.0+old/relay-abc.sock'
const deployed = {
  hostPlatform: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/dev',
  remoteRelayDir: '/home/dev/.orca-remote/relay-0.1.0+new',
  nodePath: '/usr/bin/node',
  sockPath: '/home/dev/.orca-remote/relay-0.1.0+new/relay-abc.sock'
}

function incumbent(overrides: Partial<RelayEndpointIncumbent>): RelayEndpointIncumbent {
  return {
    sockPath: OLD_SOCK,
    verdict: 'live',
    evidence: 'accepted-connection',
    socketPresent: true,
    holders: [],
    holdersEnumerable: false,
    ...overrides
  }
}

const notFound = new Error('PTY "pty2:old-epoch:1" not found')

describe('previous relay terminals', () => {
  beforeEach(() => {
    execCommand.mockReset()
    probeRelayEndpointIncumbent.mockReset()
    clearPreviousRelayCensus('target-1')
  })

  it('treats a live or unverifiable older relay as possibly holding terminals', () => {
    expect(mayHoldTerminals(incumbent({}))).toBe(true)
    expect(mayHoldTerminals(incumbent({ verdict: 'unverifiable' }))).toBe(true)
    expect(mayHoldTerminals(incumbent({ verdict: 'exited', socketPresent: false }))).toBe(false)
  })

  it('does not hold for an older relay proven to hold nothing', () => {
    const husk = incumbent({
      holdersEnumerable: true,
      holders: [{ pid: 42, matchesRelayArgv: true, childCount: 0, unrecognizedChildCount: 0 }]
    })
    expect(mayHoldTerminals(husk)).toBe(false)
  })

  it('lists older endpoints for this target only, excluding the relay just launched', async () => {
    execCommand.mockResolvedValue(`${OLD_SOCK}\n`)
    probeRelayEndpointIncumbent.mockResolvedValue(incumbent({}))

    await expect(censusPreviousRelays(conn, 'target-1', deployed)).resolves.toEqual([OLD_SOCK])

    const listing = execCommand.mock.calls[0][1]
    expect(listing).toContain("current='/home/dev/.orca-remote/relay-0.1.0+new'")
    expect(probeRelayEndpointIncumbent).toHaveBeenCalledWith(
      conn,
      deployed.hostPlatform,
      '/usr/bin/node',
      OLD_SOCK
    )
  })

  it('finds nothing to hold on a host with no older relay', async () => {
    execCommand.mockResolvedValue('')
    await expect(censusPreviousRelays(conn, 'target-1', deployed)).resolves.toEqual([])
    expect(probeRelayEndpointIncumbent).not.toHaveBeenCalled()
  })

  it('leaves Windows hosts on the existing path', async () => {
    await expect(
      censusPreviousRelays(conn, 'target-1', {
        ...deployed,
        hostPlatform: getRemoteHostPlatform('win32-x64')
      })
    ).resolves.toEqual([])
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('holds a not-found reattach while an older relay may run it', async () => {
    execCommand.mockResolvedValue(`${OLD_SOCK}\n`)
    probeRelayEndpointIncumbent.mockResolvedValue(incumbent({}))
    startPreviousRelayCensus(conn, 'target-1', deployed)

    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(true)
  })

  it('does not hold a refusal that is not a plain not-found', async () => {
    execCommand.mockResolvedValue(`${OLD_SOCK}\n`)
    probeRelayEndpointIncumbent.mockResolvedValue(incumbent({}))
    startPreviousRelayCensus(conn, 'target-1', deployed)

    const mismatch = new Error('PTY "pty2:old-epoch:1" not found (identity mismatch)')
    await expect(isReattachHeldByPreviousRelay('target-1', mismatch)).resolves.toBe(false)
    await expect(
      isReattachHeldByPreviousRelay('target-1', new Error('Request timed out'))
    ).resolves.toBe(false)
  })

  it('keeps the existing path when the census could not run or never started', async () => {
    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(false)

    execCommand.mockRejectedValue(new Error('channel closed'))
    startPreviousRelayCensus(conn, 'target-1', deployed)
    await expect(isReattachHeldByPreviousRelay('target-1', notFound)).resolves.toBe(false)
  })

  it('marks a census complete only when it ran on a host it can enumerate', async () => {
    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({ complete: false })

    execCommand.mockResolvedValue('')
    startPreviousRelayCensus(conn, 'target-1', deployed)
    await expect(previousRelayCensus('target-1')).resolves.toEqual({
      endpoints: [],
      nodePath: deployed.nodePath,
      complete: true
    })

    startPreviousRelayCensus(conn, 'target-1', {
      ...deployed,
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({ complete: false })

    execCommand.mockRejectedValue(new Error('channel closed'))
    startPreviousRelayCensus(conn, 'target-1', deployed)
    await expect(previousRelayCensus('target-1')).resolves.toMatchObject({ complete: false })
  })
})

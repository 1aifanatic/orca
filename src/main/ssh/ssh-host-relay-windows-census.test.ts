import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { execCommand, probeRelayVersionDirLiveness, countRelayPtysOverBridge } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  probeRelayVersionDirLiveness: vi.fn(),
  countRelayPtysOverBridge: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))
vi.mock('./remote-install-gc', () => ({ probeRelayVersionDirLiveness }))
vi.mock('./ssh-relay-endpoint-pty-count', () => ({ countRelayPtysOverBridge }))

import { censusWindowsHostRelays } from './ssh-host-relay-windows-census'

// The census only hands the connection to the mocked exec, probe and bridge.
const conn: SshConnection = Object.create(null)
const host = getRemoteHostPlatform('win32-x64')

const census = (nodePath: () => Promise<string | null> = async () => 'C:\\node\\node.exe') =>
  censusWindowsHostRelays(conn, {
    host,
    remoteHome: 'C:\\Users\\dev',
    targetId: 'ssh-1',
    nodePath
  })

describe('the connect-time relay census on a Windows host', () => {
  beforeEach(() => {
    execCommand.mockReset().mockResolvedValue('relay-0.1.0+aaaaaaaaaaaa\r\nnode_modules\r\n')
    probeRelayVersionDirLiveness.mockReset().mockResolvedValue('live')
    countRelayPtysOverBridge.mockReset().mockResolvedValue(null)
  })

  it('finds none on a host that never ran a relay', async () => {
    execCommand.mockResolvedValue('')
    await expect(census()).resolves.toEqual({ verdict: 'none', count: 0 })
  })

  it('counts a shell the live relay runs that no lease here knows', async () => {
    // The pipe the relay is on answers; the fallback pipe name has nothing behind it.
    countRelayPtysOverBridge.mockResolvedValueOnce(1).mockResolvedValueOnce(null)

    await expect(census()).resolves.toEqual({ verdict: 'live', count: 1 })
    expect(countRelayPtysOverBridge).toHaveBeenCalledWith(
      conn,
      // The bridge runs as PowerShell, encoded, from that version directory.
      expect.any(String),
      undefined,
      { wrapCommand: false }
    )
  })

  it('never converts under a live pipe it cannot ask', async () => {
    await expect(census()).resolves.toEqual({ verdict: 'unverifiable', count: 1 })
  })

  it('reads a relay that answers with no PTYs, or a pipe that exited, as idle', async () => {
    countRelayPtysOverBridge.mockResolvedValueOnce(0).mockResolvedValueOnce(null)
    await expect(census()).resolves.toEqual({ verdict: 'idle', count: 0 })

    probeRelayVersionDirLiveness.mockResolvedValue('exited')
    await expect(census()).resolves.toEqual({ verdict: 'idle', count: 0 })
  })

  it.each([
    ['the version listing failed', () => execCommand.mockRejectedValue(new Error('pwsh exited'))],
    ['the host has no Node to probe with', () => {}]
  ])('is unverifiable when %s', async (_label, arrange) => {
    arrange()
    await expect(census(async () => null)).resolves.toMatchObject({ verdict: 'unverifiable' })
  })
})

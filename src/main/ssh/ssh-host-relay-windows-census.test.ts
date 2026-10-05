import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const { execCommand, countRelayPtysOverBridge } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  countRelayPtysOverBridge: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand }))
vi.mock('./ssh-relay-endpoint-pty-count', () => ({ countRelayPtysOverBridge }))
vi.mock('./ssh-remote-commands', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listRemoteInstallBaseDirsCommand: () => 'LIST',
  relayLivenessProbeCommand: (_host: unknown, _dir: string, options: { pipePaths: string[] }) =>
    `PROBE ${options.pipePaths[0]}`
}))

import { censusWindowsHostRelays } from './ssh-host-relay-windows-census'

// The census only hands the connection to the mocked exec and bridge.
const conn: SshConnection = Object.create(null)
const host = getRemoteHostPlatform('win32-x64')

let listing = ''
/** Each pipe's probe token, in probe order: the directory's primary pipe, then its fallback. */
let pipeTokens: string[] = []

const census = (nodePath: () => Promise<string | null> = async () => 'C:\\node\\node.exe') =>
  censusWindowsHostRelays(conn, {
    host,
    remoteHome: 'C:\\Users\\dev',
    targetId: 'ssh-1',
    nodePath
  })

describe('the connect-time relay census on a Windows host', () => {
  beforeEach(() => {
    listing = 'relay-0.1.0+aaaaaaaaaaaa\r\nnode_modules\r\n'
    pipeTokens = ['ALIVE', 'DEAD']
    execCommand.mockReset().mockImplementation(async (_conn: unknown, command: string) => {
      if (command === 'LIST') {
        return listing
      }
      return pipeTokens.shift() ?? 'DEAD'
    })
    countRelayPtysOverBridge.mockReset().mockResolvedValue(null)
  })

  it('finds none on a host that never ran a relay', async () => {
    listing = ''
    await expect(census()).resolves.toEqual({ verdict: 'none', count: 0 })
  })

  it('counts a shell the live relay runs that no lease here knows', async () => {
    countRelayPtysOverBridge.mockResolvedValue(1)

    await expect(census()).resolves.toEqual({ verdict: 'live', count: 1 })
    // Only the live pipe is asked, as PowerShell run from that version directory.
    expect(countRelayPtysOverBridge).toHaveBeenCalledTimes(1)
    expect(countRelayPtysOverBridge).toHaveBeenCalledWith(conn, expect.any(String), undefined, {
      wrapCommand: false
    })
  })

  it('never converts under a live pipe it cannot ask', async () => {
    await expect(census()).resolves.toEqual({ verdict: 'unverifiable', count: 1 })
  })

  it('stays unverifiable when one pipe answers empty and the other is live but cannot be asked', async () => {
    pipeTokens = ['ALIVE', 'ALIVE']
    countRelayPtysOverBridge.mockResolvedValueOnce(0).mockResolvedValueOnce(null)

    await expect(census()).resolves.toEqual({ verdict: 'unverifiable', count: 1 })
  })

  it('reads a relay that answers with no PTYs, or pipes that exited, as idle', async () => {
    countRelayPtysOverBridge.mockResolvedValue(0)
    await expect(census()).resolves.toEqual({ verdict: 'idle', count: 0 })

    pipeTokens = ['DEAD', 'DEAD']
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

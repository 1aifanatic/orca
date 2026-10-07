import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unixSocketPathFits } from '../../shared/unix-socket-path-limit'
import { getDaemonSocketBindPath } from './daemon-endpoint-ownership'
import { getDaemonSocketPath } from './daemon-spawner'
import {
  ensureDaemonSocketDir,
  resolveDaemonUnixSocketPath,
  shortDaemonSocketDir
} from './daemon-socket-endpoint-path'

const SOCKET_NAME = 'daemon-v99.sock'
const longRuntimeDir = (bytes: number): string => `/home/${'u'.repeat(bytes - 20)}/orca/daemon`

describe('resolveDaemonUnixSocketPath (#17840)', () => {
  it.each(['linux', 'darwin'] as const)(
    'keeps the userData endpoint for a short root on %s',
    (os) => {
      expect(
        resolveDaemonUnixSocketPath('/home/me/.config/orca/daemon', SOCKET_NAME, os, 1000)
      ).toBe(`/home/me/.config/orca/daemon/${SOCKET_NAME}`)
    }
  )

  it.each(['linux', 'darwin'] as const)(
    'moves a 120-byte root to the per-uid short dir on %s, and the bind name fits too',
    (os) => {
      const runtimeDir = longRuntimeDir(120)
      const resolved = resolveDaemonUnixSocketPath(runtimeDir, SOCKET_NAME, os, 1000)
      expect(resolved).toBe(`${shortDaemonSocketDir(runtimeDir, 1000)}/${SOCKET_NAME}`)
      expect(unixSocketPathFits(resolved, os)).toBe(true)
      expect(unixSocketPathFits(getDaemonSocketBindPath(resolved), os)).toBe(true)
    }
  )

  it('relocates on darwin at a length linux still accepts', () => {
    // 104-byte darwin sun_path vs 108 on linux.
    const runtimeDir = `/h/${'x'.repeat(105 - 3 - 1 - SOCKET_NAME.length)}`
    expect(resolveDaemonUnixSocketPath(runtimeDir, SOCKET_NAME, 'linux', 1)).toBe(
      `${runtimeDir}/${SOCKET_NAME}`
    )
    expect(resolveDaemonUnixSocketPath(runtimeDir, SOCKET_NAME, 'darwin', 1)).not.toContain(
      runtimeDir
    )
  })

  it('gives distinct data roots distinct short dirs', () => {
    expect(shortDaemonSocketDir(longRuntimeDir(120), 1)).not.toBe(
      shortDaemonSocketDir(`${longRuntimeDir(120)}x`, 1)
    )
  })
})

describe.skipIf(process.platform === 'win32')('relocated endpoint binds (#17840)', () => {
  const uid = process.getuid!()
  let base = ''
  let runtimeDir = ''

  afterEach(() => {
    rmSync(shortDaemonSocketDir(runtimeDir, uid), { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
    try {
      rmdirSync(dirname(shortDaemonSocketDir(runtimeDir, uid)))
    } catch {
      // Not empty: another Orca on this machine uses it.
    }
  })

  it('creates a private dir the over-long data root can bind its socket in', async () => {
    base = mkdtempSync(join(tmpdir(), 'orca-long-'))
    runtimeDir = join(base, 'x'.repeat(130))
    mkdirSync(runtimeDir, { recursive: true })
    const socketPath = getDaemonSocketPath(runtimeDir, 99)
    expect(socketPath.startsWith(runtimeDir)).toBe(false)

    ensureDaemonSocketDir(socketPath)
    expect(lstatSync(shortDaemonSocketDir(runtimeDir, uid)).mode & 0o777).toBe(0o700)
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(getDaemonSocketBindPath(socketPath), resolve)
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('refuses a shared short dir rather than repairing it', () => {
    base = mkdtempSync(join(tmpdir(), 'orca-long-'))
    runtimeDir = join(base, 'x'.repeat(130))
    const socketPath = getDaemonSocketPath(runtimeDir, 99)
    ensureDaemonSocketDir(socketPath)
    chmodSync(shortDaemonSocketDir(runtimeDir, uid), 0o777)
    expect(() => ensureDaemonSocketDir(socketPath)).toThrow(/not a private directory/)
  })
})

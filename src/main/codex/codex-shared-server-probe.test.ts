import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      throw new Error('tests pass explicit homes')
    }
  }
}))

import {
  probeCodexSharedServer,
  reportCodexSharedServerInOwnedHome
} from './codex-shared-server-probe'

const isWindows = process.platform === 'win32'

describe('Codex shared-server probe in an Orca-owned home', () => {
  let root: string
  let home: string
  let server: Server | null = null

  beforeEach(() => {
    // Why: /tmp keeps the socket path under every sun_path limit on POSIX hosts.
    root = mkdtempSync(join(isWindows ? tmpdir() : '/tmp', 'cxp-'))
    home = join(root, 'home')
    mkdirSync(join(home, 'app-server-control'), { recursive: true })
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = null
    }
    rmSync(root, { recursive: true, force: true })
  })

  const socketPath = (): string => join(home, 'app-server-control', 'app-server-control.sock')

  it('reports exited when no server was ever started', async () => {
    expect(await probeCodexSharedServer(home)).toBe('exited')
  })

  it('reports exited without touching the disk when the socket path cannot be bound', async () => {
    expect(await probeCodexSharedServer(`/${'a'.repeat(80)}`, 'linux')).toBe('exited')
  })

  it.runIf(!isWindows)('reports live while a server accepts connections, then exited', async () => {
    server = createServer((socket) => socket.destroy())
    await new Promise<void>((resolve) => server!.listen(socketPath(), resolve))
    expect(await probeCodexSharedServer(home)).toBe('live')
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    expect(await probeCodexSharedServer(home)).toBe('exited')
  })

  it.runIf(isWindows)('reports unverifiable when only the socket file is visible', async () => {
    writeFileSync(socketPath(), '')
    expect(await probeCodexSharedServer(home)).toBe('unverifiable')
  })

  it.runIf(!isWindows)(
    'logs once per running server, and again after it exits and returns',
    async () => {
      const log = vi.fn()
      await reportCodexSharedServerInOwnedHome(home, process.platform, log)
      expect(log).not.toHaveBeenCalled()

      server = createServer((socket) => socket.destroy())
      await new Promise<void>((resolve) => server!.listen(socketPath(), resolve))
      await reportCodexSharedServerInOwnedHome(home, process.platform, log)
      await reportCodexSharedServerInOwnedHome(home, process.platform, log)
      expect(log).toHaveBeenCalledTimes(1)
      expect(String(log.mock.calls[0]?.[0])).toContain(home)
      expect(String(log.mock.calls[0]?.[0])).toContain('Orca leaves it running')

      await new Promise<void>((resolve) => server!.close(() => resolve()))
      await reportCodexSharedServerInOwnedHome(home, process.platform, log)
      server = createServer((socket) => socket.destroy())
      await new Promise<void>((resolve) => server!.listen(socketPath(), resolve))
      await reportCodexSharedServerInOwnedHome(home, process.platform, log)
      expect(log).toHaveBeenCalledTimes(2)
    }
  )

  it('skips WSL homes, whose Linux socket the host cannot reach', async () => {
    const log = vi.fn()
    await reportCodexSharedServerInOwnedHome(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.local\\share\\orca\\codex-accounts\\a\\home',
      'win32',
      log
    )
    expect(log).not.toHaveBeenCalled()
  })
})

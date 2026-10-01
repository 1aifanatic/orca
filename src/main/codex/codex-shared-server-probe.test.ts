import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readWindowsProcessCreationTime } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../windows/windows-process-table', () => ({ readWindowsProcessCreationTime }))

import { isCodexSharedServerLive } from './codex-shared-server-probe'

const originalPlatform = process.platform
let home: string
let server: Server | null = null

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function listen(): Promise<void> {
  mkdirSync(join(home, 'app-server-control'), { recursive: true })
  const listening = createServer((socket) => socket.destroy())
  server = listening
  return new Promise((resolve) =>
    listening.listen(join(home, 'app-server-control', 'app-server-control.sock'), resolve)
  )
}

function close(): Promise<void> {
  const listening = server
  server = null
  return new Promise((resolve) => (listening ? listening.close(() => resolve()) : resolve()))
}

beforeEach(() => {
  // Why /tmp: a unix socket path must fit sun_path, which a macOS $TMPDIR can exceed.
  home = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cxh-'))
  readWindowsProcessCreationTime.mockReset()
})

afterEach(async () => {
  setPlatform(originalPlatform)
  await close()
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('isCodexSharedServerLive on POSIX', () => {
  beforeEach(() => setPlatform('darwin'))

  it('is live while the control socket accepts connections', async () => {
    await listen()
    await expect(isCodexSharedServerLive(home)).resolves.toBe(true)
  })

  it('is not live when no socket exists', async () => {
    await expect(isCodexSharedServerLive(home)).resolves.toBe(false)
  })

  it('is not live when a crashed server left its socket file behind', async () => {
    mkdirSync(join(home, 'app-server-control'), { recursive: true })
    writeFileSync(join(home, 'app-server-control', 'app-server-control.sock'), '')
    await expect(isCodexSharedServerLive(home)).resolves.toBe(false)
  })
})

describe('isCodexSharedServerLive on Windows', () => {
  const START_FILETIME = '134352704749372843'
  const START_UNIX_MS = 1_790_796_874_937

  beforeEach(() => setPlatform('win32'))

  function writeRecord(name: string, record: unknown): void {
    mkdirSync(join(home, 'app-server-daemon'), { recursive: true })
    writeFileSync(join(home, 'app-server-daemon', name), JSON.stringify(record))
  }

  it('is live when the recorded pid still has the recorded creation time', async () => {
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS)
    await expect(isCodexSharedServerLive(home)).resolves.toBe(true)
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(27368)
  })

  it('reads the legacy record name', async () => {
    writeRecord('app-server.pid', { pid: 27368, processStartTime: START_FILETIME })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS)
    await expect(isCodexSharedServerLive(home)).resolves.toBe(true)
  })

  it('is not live when the pid was reused by a later process', async () => {
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS + 60_000)
    await expect(isCodexSharedServerLive(home)).resolves.toBe(false)
  })

  it('is not live when the pid is gone or the record is missing or malformed', async () => {
    readWindowsProcessCreationTime.mockReturnValue(null)
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    await expect(isCodexSharedServerLive(home)).resolves.toBe(false)
    writeRecord('daemon.pid', { pid: 27368, processStartTime: 'Wed Sep 30 15:33:16 2026' })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS)
    await expect(isCodexSharedServerLive(home)).resolves.toBe(false)
    rmSync(join(home, 'app-server-daemon'), { recursive: true })
    await expect(isCodexSharedServerLive(home)).resolves.toBe(false)
  })
})

import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CodexHookSessionTrust from './codex-hook-session-trust'

const mocks = vi.hoisted(() => ({
  handleCodexHookFlagRequest: vi.fn(),
  refreshCodexHookSessionFlagsAfter: vi.fn(),
  pruneCodexHookSessionFlags: vi.fn(async () => {})
}))

vi.mock('./codex-hook-session-trust', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexHookSessionTrust>()),
  ...mocks
}))
vi.mock('./codex-cmd-hook-flag-gate', () => ({ ensureCodexCmdHookFlagGate: () => {} }))

import {
  nudgeCodexHookFlagRequests,
  reconcileCodexHookFlagTable,
  startCodexHookFlagRequests
} from './codex-hook-flag-requests'
import { createCodexHookFlagTable, getCodexHookFlagTablePath } from './codex-hook-flag-table'

// Why a fake watch: these tests pin what the code does with events, not when an OS delivers them.
class FakeWatcher extends EventEmitter {
  closed = false
  close(): void {
    this.closed = true
  }
  unref(): this {
    return this
  }
}

const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0

describe('Codex hook flag table lifecycle and requests', () => {
  let userData: string
  let enabled: boolean
  let watchers: { watcher: FakeWatcher; fire: () => void }[]
  let stop: () => void = () => {}

  function start(options: { watch?: () => FSWatcher; pathReady?: Promise<unknown> } = {}): void {
    stop = startCodexHookFlagRequests({
      isEnabled: () => enabled,
      pathReady: options.pathReady,
      watch:
        options.watch ??
        ((_path, onChange) => {
          const watcher = new FakeWatcher()
          watchers.push({ watcher, fire: onChange })
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test calls only on/close/unref, which FakeWatcher implements.
          return watcher as unknown as FSWatcher
        })
    })
  }

  function writeLaunchRequest(version: string): void {
    // Why a raw write: the shell carrier writes this file, not Orca's helper.
    writeFileSync(join(getCodexHookFlagTablePath(), `${version}.request`), '/usr/local/bin/codex\n')
  }

  const served = (version: string) =>
    expect(mocks.handleCodexHookFlagRequest).toHaveBeenCalledWith({
      codexVersion: version,
      codexPath: '/usr/local/bin/codex'
    })

  beforeEach(() => {
    vi.useFakeTimers()
    userData = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-requests-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', userData)
    enabled = true
    watchers = []
    for (const mock of Object.values(mocks)) {
      mock.mockClear()
    }
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    const table = join(userData, 'codex-hook-flags')
    if (existsSync(table)) {
      chmodSync(table, 0o755)
    }
    rmSync(userData, { recursive: true, force: true })
  })

  it('creates the table at start, serves requests left while Orca was closed, and starts the default derivation', async () => {
    createCodexHookFlagTable()
    writeLaunchRequest('codex-cli 0.159.2')
    const pathReady = Promise.resolve()

    start({ pathReady })
    await vi.advanceTimersByTimeAsync(0)

    served('codex-cli 0.159.2')
    expect(existsSync(join(getCodexHookFlagTablePath(), 'codex-cli 0.159.2.request'))).toBe(false)
    expect(mocks.refreshCodexHookSessionFlagsAfter).toHaveBeenCalledWith(pathReady)
  })

  it('drains on any watch event, whatever name the OS reports', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    writeLaunchRequest('codex-cli 0.160.0')

    // Why no name: macOS reports a burst under the directory's own name, or none.
    watchers[0].fire()
    await vi.advanceTimersByTimeAsync(100)

    served('codex-cli 0.160.0')
  })

  it('serves a request written just after the watch opened, which the watch missed', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    writeLaunchRequest('codex-cli 0.160.0')

    await vi.advanceTimersByTimeAsync(1_000)

    served('codex-cli 0.160.0')
  })

  it('serves requests on the next pane spawn when the watch cannot open', async () => {
    start({
      watch: () => {
        throw Object.assign(new Error('inotify limit'), { code: 'ENOSPC' })
      }
    })
    await vi.advanceTimersByTimeAsync(1_000)
    writeLaunchRequest('codex-cli 0.160.0')

    nudgeCodexHookFlagRequests()
    await vi.advanceTimersByTimeAsync(100)

    served('codex-cli 0.160.0')
  })

  it('drops a failed watch and keeps serving through pane spawns', async () => {
    start()
    await vi.advanceTimersByTimeAsync(1_000)
    watchers[0].watcher.emit('error', new Error('watch lost'))
    expect(watchers[0].watcher.closed).toBe(true)
    writeLaunchRequest('codex-cli 0.160.0')

    nudgeCodexHookFlagRequests()
    await vi.advanceTimersByTimeAsync(100)

    served('codex-cli 0.160.0')
  })

  it('removes the table at start while Codex hooks are off, serving nothing', async () => {
    enabled = false
    createCodexHookFlagTable()
    writeLaunchRequest('codex-cli 0.159.2')

    start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(existsSync(getCodexHookFlagTablePath())).toBe(false)
    expect(mocks.handleCodexHookFlagRequest).not.toHaveBeenCalled()
    expect(mocks.refreshCodexHookSessionFlagsAfter).not.toHaveBeenCalled()
  })

  it('follows the setting when it runs, not the toggle that queued it', () => {
    start()
    // Why: an opt-out queued behind a busy lane runs after the user turned hooks back on.
    reconcileCodexHookFlagTable(false)
    expect(existsSync(getCodexHookFlagTablePath())).toBe(true)

    enabled = false
    reconcileCodexHookFlagTable(true)
    expect(existsSync(getCodexHookFlagTablePath())).toBe(false)
  })

  it('watches the table again when hooks turn back on after the opt-out removed it', async () => {
    start()
    enabled = false
    reconcileCodexHookFlagTable()
    expect(watchers[0].watcher.closed).toBe(true)

    enabled = true
    reconcileCodexHookFlagTable()
    await vi.advanceTimersByTimeAsync(1_000)
    writeLaunchRequest('codex-cli 0.160.0')
    watchers[1].fire()
    await vi.advanceTimersByTimeAsync(100)

    served('codex-cli 0.160.0')
  })

  it('skips a request that is a directory instead of failing the drain', async () => {
    createCodexHookFlagTable()
    mkdirSync(join(getCodexHookFlagTablePath(), 'codex-cli 9.9.9.request'))
    writeLaunchRequest('codex-cli 0.159.2')

    expect(() => start()).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)

    served('codex-cli 0.159.2')
    expect(mocks.handleCodexHookFlagRequest).toHaveBeenCalledTimes(1)
  })

  describe.skipIf(!canDenyWrites)('when a delete fails', () => {
    it('still starts with hooks off when the table cannot be removed', () => {
      enabled = false
      createCodexHookFlagTable()
      writeLaunchRequest('codex-cli 0.159.2')
      chmodSync(getCodexHookFlagTablePath(), 0o555)

      expect(() => start()).not.toThrow()
      expect(existsSync(getCodexHookFlagTablePath())).toBe(true)
    })

    it('still serves a request it cannot delete', async () => {
      createCodexHookFlagTable()
      writeLaunchRequest('codex-cli 0.159.2')
      chmodSync(getCodexHookFlagTablePath(), 0o555)

      expect(() => start()).not.toThrow()
      await vi.advanceTimersByTimeAsync(0)

      served('codex-cli 0.159.2')
    })
  })
})

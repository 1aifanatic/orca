import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn(),
  runCodexAppServerSession: vi.fn(),
  mainPath: ''
}))

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.runProcess }))
vi.mock('./codex-app-server-session', () => ({
  runCodexAppServerSession: mocks.runCodexAppServerSession
}))
vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: () => mocks.mainPath,
  withCliRuntimeOnPath: (_path: string, env: NodeJS.ProcessEnv) => env
}))

import {
  _internals,
  getKnownCodexHookFlag,
  learnCodexHookFlagVersion,
  startCodexHookFlagSync,
  syncCodexHookFlags,
  syncCodexHookFlagsWithin
} from './codex-hook-flag-sync'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getManagedCommand,
  getManagedScriptPath
} from './codex-hook-definition'
import {
  getCodexHookFlagTablePath,
  publishCodexHookFlagEntry,
  readCodexHookFlagEntry
} from './codex-hook-flag-table'

// Why a fake watch: these tests pin what the code does with an event, not when an OS delivers it.
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
const versions = new Map<string, string | null>()

function listingFor(flag: string): unknown {
  const approved = /state\s*=/.test(flag)
  return {
    data: [
      {
        hooks: CODEX_EVENTS.map((eventName) => {
          const label = CODEX_EVENT_LABEL[eventName]
          return {
            key: `/<session-flags>/config.toml:${label}:0:0`,
            command: getManagedCommand(getManagedScriptPath()),
            currentHash: `sha256:${label}`,
            trustStatus: approved ? 'trusted' : 'untrusted',
            source: 'sessionFlags',
            enabled: true
          }
        })
      }
    ]
  }
}

function versionCalls(): string[] {
  return mocks.runProcess.mock.calls
    .filter(([options]) => options.args[0] === '--version')
    .map(([options]) => options.program)
}

describe('syncCodexHookFlags', () => {
  let root: string
  let enabled: boolean
  let watchers: { watcher: FakeWatcher; fire: () => void }[]
  let stop: () => void = () => {}

  function writeBinary(path: string, content = 'codex'): string {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    return path
  }

  function start(pathReady?: Promise<unknown>): Promise<void> {
    stop = startCodexHookFlagSync({
      isEnabled: () => enabled,
      pathReady,
      watch: (_path, onChange) => {
        const watcher = new FakeWatcher()
        watchers.push({ watcher, fire: onChange })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the code under test calls only on/close/unref, which FakeWatcher implements.
        return watcher as unknown as FSWatcher
      }
    })
    return syncCodexHookFlagsWithin(5_000)
  }

  const table = () => getCodexHookFlagTablePath()
  const entryFor = (version: string) => readCodexHookFlagEntry(version)

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-sync-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    // Why: the sync writes the hook script under ~/.orca.
    vi.stubEnv('HOME', join(root, 'home'))
    vi.stubEnv('USERPROFILE', join(root, 'home'))
    mkdirSync(join(root, 'user-data'))
    _internals.resetForTesting()
    enabled = true
    watchers = []
    versions.clear()
    mocks.mainPath = writeBinary(join(root, 'bin', 'codex'))
    versions.set(mocks.mainPath, 'codex-cli 0.159.2')
    mocks.runProcess.mockReset()
    mocks.runProcess.mockImplementation(async ({ program, args }) => {
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: codex [--no-daemon]', stderr: '', signal: null }
      }
      const version = versions.get(program) ?? null
      return version === null
        ? { code: 1, stdout: '', stderr: 'boom', signal: null, timedOut: false }
        : { code: 0, stdout: `${version}\n`, stderr: '', signal: null, timedOut: false }
    })
    mocks.runCodexAppServerSession.mockReset()
    mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) =>
      body({ request: async () => listingFor(invocation.args[1]) })
    )
  })

  afterEach(() => {
    stop()
    _internals.resetForTesting()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    const userTable = join(root, 'user-data', 'codex-hook-flags')
    if (existsSync(userTable)) {
      chmodSync(userTable, 0o755)
    }
    rmSync(root, { recursive: true, force: true })
  })

  it("derives for Orca's codex once the shell PATH is ready, and a resume's wait sees it", async () => {
    let pathReady!: () => void
    const ready = new Promise<void>((resolve) => {
      pathReady = resolve
    })
    let waited = false
    const wait = start(ready).then(() => {
      waited = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(waited).toBe(false)
    expect(versionCalls()).toEqual([])

    pathReady()
    await wait

    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
    expect(getKnownCodexHookFlag()).toEqual({ version: 'codex-cli 0.159.2', failure: null })
  })

  it('writes the hook script before any entry, so a codex installed after start runs it', async () => {
    await start()

    expect(existsSync(getManagedScriptPath())).toBe(true)
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('derives nothing when the hook script cannot be written', async () => {
    mkdirSync(join(root, 'home'))
    // Why a file where the folder goes: the script's mkdir then fails.
    writeFileSync(join(root, 'home', '.orca'), '')

    await start()

    expect(versionCalls()).toEqual([])
    expect(readdirSync(table())).toEqual([])
  })

  it('turns off at once, even mid-derivation, and the derivation then publishes nothing', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.runCodexAppServerSession.mockImplementation(async (invocation, body) => {
      await gate
      return body({ request: async () => listingFor(invocation.args[1]) })
    })
    const first = start()
    await vi.waitFor(() => expect(mocks.runCodexAppServerSession).toHaveBeenCalled())

    enabled = false
    await syncCodexHookFlags()
    expect(existsSync(table())).toBe(false)
    release()
    await first

    expect(existsSync(table())).toBe(false)
  })

  it('spawns nothing for a binary whose fingerprint is unchanged, and re-derives one that changed', async () => {
    await start()
    expect(versionCalls()).toHaveLength(1)

    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(1)

    // Why new bytes: an update replaces the binary behind the same path.
    writeBinary(mocks.mainPath, 'codex, updated')
    versions.set(mocks.mainPath, 'codex-cli 0.160.0')
    await syncCodexHookFlags()

    expect(versionCalls()).toHaveLength(2)
    expect(entryFor('codex-cli 0.160.0')).not.toBeNull()
  })

  it('re-derives when its entry is gone, even for an unchanged binary', async () => {
    await start()
    rmSync(join(table(), 'codex-cli 0.159.2.flag'))

    await syncCodexHookFlags()

    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it('caches a failure per fingerprint until the binary changes or hooks are toggled', async () => {
    mocks.runCodexAppServerSession.mockRejectedValue(new Error('timed out'))
    await start()
    expect(getKnownCodexHookFlag()?.failure).toBe('timed out')

    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(1)

    enabled = false
    await syncCodexHookFlags()
    enabled = true
    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(2)

    writeBinary(mocks.mainPath, 'codex, reinstalled')
    await syncCodexHookFlags()
    expect(versionCalls()).toHaveLength(3)
  })

  it('prunes entries whose definition this build no longer writes', async () => {
    mkdirSync(table(), { recursive: true })
    publishCodexHookFlagEntry({
      codexVersion: 'codex-cli 0.1.0',
      flag: 'hooks={old}',
      noDaemon: false
    })

    await start()

    expect(entryFor('codex-cli 0.1.0')).toBeNull()
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it("serves a launch's request for its own binary, through npm's codex.cmd for codex.ps1", async () => {
    await start()
    const npm = join(root, 'npm')
    writeBinary(join(npm, 'codex.ps1'))
    const cmd = writeBinary(join(npm, 'codex.cmd'))
    versions.set(cmd, 'codex-cli 0.150.1')
    // Why a BOM: PowerShell 5.1's Set-Content -Encoding UTF8 writes one.
    writeFileSync(join(table(), 'codex-cli 0.150.1.request'), `﻿${join(npm, 'codex.ps1')}\r\n`)

    await syncCodexHookFlags()

    expect(versionCalls()).toContain(cmd)
    expect(entryFor('codex-cli 0.150.1')).not.toBeNull()
  })

  it("derives for Orca's own codex when a request names no codex binary", async () => {
    await start()
    writeFileSync(join(table(), 'codex-cli 9.9.9.request'), '/tmp/evil\n')

    await syncCodexHookFlags()

    expect(versionCalls()).not.toContain('/tmp/evil')
  })

  it('derives for the binary an Orca-side launch names', async () => {
    await start()
    const pane = writeBinary(join(root, 'mise', 'codex'))
    versions.set(pane, 'codex-cli 0.150.1')

    await syncCodexHookFlags({ codexPath: pane })

    expect(entryFor('codex-cli 0.150.1')).not.toBeNull()
  })

  it('syncs on any watch event, whatever name the OS reports', async () => {
    await start()
    const pane = writeBinary(join(root, 'pane', 'codex'))
    versions.set(pane, 'codex-cli 0.150.1')
    writeFileSync(join(table(), 'codex-cli 0.150.1.request'), `${pane}\n`)

    // Why no name: macOS reports a burst under the directory's own name, or none.
    watchers[0].fire()

    await vi.waitFor(() => expect(entryFor('codex-cli 0.150.1')).not.toBeNull())
  })

  it('drops a failed watch and opens a new one at the next sync', async () => {
    await start()
    watchers[0].watcher.emit('error', new Error('watch lost'))
    expect(watchers[0].watcher.closed).toBe(true)

    await syncCodexHookFlags()

    expect(watchers).toHaveLength(2)
  })

  it('never throws on a request that is a directory', async () => {
    mkdirSync(join(table(), 'codex-cli 9.9.9.request'), { recursive: true })

    await expect(start()).resolves.toBeUndefined()
    expect(entryFor('codex-cli 0.159.2')).not.toBeNull()
  })

  it.skipIf(!canDenyWrites)(
    'never throws when hooks are off and the table cannot be removed',
    async () => {
      mkdirSync(table(), { recursive: true })
      writeFileSync(join(table(), 'codex-cli 9.9.9.request'), '')
      chmodSync(table(), 0o555)
      enabled = false

      expect(() => start()).not.toThrow()
      await expect(syncCodexHookFlags()).resolves.toBeUndefined()
      expect(existsSync(table())).toBe(true)
    }
  )

  describe("in the CLI's process", () => {
    it('follows the saved setting without deriving, and does nothing when given none', async () => {
      mkdirSync(table(), { recursive: true })
      await syncCodexHookFlags()
      expect(existsSync(table())).toBe(true)

      await syncCodexHookFlags({ enabled: true })
      expect(existsSync(table())).toBe(true)
      expect(existsSync(getManagedScriptPath())).toBe(true)
      expect(versionCalls()).toEqual([])

      await syncCodexHookFlags({ enabled: false })
      expect(existsSync(table())).toBe(false)
    })

    it('learns its codex version for status', async () => {
      await learnCodexHookFlagVersion()

      expect(getKnownCodexHookFlag()).toEqual({ version: 'codex-cli 0.159.2', failure: null })
    })
  })
})

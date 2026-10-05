import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as InstallerUtils from '../agent-hooks/installer-utils'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import type * as RealHomeHooksJson from './codex-real-home-hooks-json'
import type * as StateDb from './codex-state-db'
import type { CodexHookListing } from './codex-app-server-client'

const mocks = vi.hoisted(() => {
  const spies: {
    beforeHooksJsonWrite: (() => void) | null
    beforeBackup: (() => void) | null
    backfill: 'pending' | 'not-pending'
  } = { beforeHooksJsonWrite: null, beforeBackup: null, backfill: 'not-pending' }
  return {
    spies,
    homedir: vi.fn<() => string>(),
    codexPath: '',
    probeCodexVersion: vi.fn(),
    deriveCodexHookHashes: vi.fn(),
    listCodexHooks: vi.fn()
  }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: mocks.homedir
}))
vi.mock('../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<typeof CodexCommand>()),
  resolveCodexCommand: () => mocks.codexPath
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes,
  listCodexHooks: mocks.listCodexHooks
}))
vi.mock('./codex-state-db', async (importOriginal) => ({
  ...(await importOriginal<typeof StateDb>()),
  readCodexStateDbBackfillPendingState: () => mocks.spies.backfill
}))
vi.mock('../agent-hooks/installer-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof InstallerUtils>()
  return {
    ...actual,
    writeHooksJson: (...args: Parameters<typeof actual.writeHooksJson>) => {
      mocks.spies.beforeHooksJsonWrite?.()
      return actual.writeHooksJson(...args)
    }
  }
})
vi.mock('./codex-real-home-hooks-json', async (importOriginal) => {
  const actual = await importOriginal<typeof RealHomeHooksJson>()
  return {
    ...actual,
    backupRealHomeHooksJsonOnce: (
      ...args: Parameters<typeof actual.backupRealHomeHooksJsonOnce>
    ) => {
      mocks.spies.beforeBackup?.()
      return actual.backupRealHomeHooksJsonOnce(...args)
    }
  }
})

import {
  _internals,
  getCodexRealHomeLaneProblem,
  isCodexRealHomeLaneUsable,
  reconcileCodexHooks,
  resolveCodexHookAnswerForLaunch,
  resolveCodexHookHashes,
  startCodexHookReconcile
} from './codex-hook-reconcile'
import { _internals as memoInternals, getCodexHookTrustMemoPath } from './codex-hook-trust-memo'
import { CodexHookService } from './codex-hook-service-implementation'
import { computeCodexHookHashesForTests } from './hook-service-test-harness'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { CODEX_HOOK_EVENT_LABEL } from './codex-hook-identity'
import {
  computeTrustKey,
  computeTrustedHash,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

// Why this file: the ways ~/.codex can refuse Orca's approved entry, and the
// fallbacks that keep status working and the user's files intact then.

let home: string
let userData: string
let enabled: boolean
let stop: (() => void) | null = null
const mirror = (): string => join(userData, 'codex-runtime-home', 'home')
const codexHome = (): string => join(home, '.codex')
const hooksPath = (): string => join(codexHome(), 'hooks.json')
const tomlPath = (): string => join(codexHome(), 'config.toml')
const command = (): string => getCodexManagedHookInstallMaterial().command

function stopEntry(sourcePath = hooksPath(), groupIndex = 0): CodexTrustEntry {
  return { sourcePath, eventLabel: 'stop', groupIndex, handlerIndex: 0, command: command() }
}

function readHooks(): Record<string, { hooks: { command: string }[] }[]> {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8')).hooks
}

/** Codex's own read of ~/.codex, keyed as Codex keys the default home: as spelled. */
function listLikeCodex(): CodexHookListing[] {
  const trust = readHookTrustEntries(tomlPath())
  return Object.entries(readHooks()).flatMap(([eventName, groups]) => {
    const eventLabel = CODEX_HOOK_EVENT_LABEL[eventName]
    if (!eventLabel) {
      return []
    }
    return groups.flatMap((group, groupIndex) =>
      group.hooks.map((hook, handlerIndex) => {
        const entry: CodexTrustEntry = {
          sourcePath: hooksPath(),
          eventLabel,
          groupIndex,
          handlerIndex,
          command: hook.command,
          timeoutSec: 10
        }
        const currentHash = computeTrustedHash(entry)
        return {
          key: computeTrustKey(entry),
          command: hook.command,
          currentHash,
          trustStatus:
            trust.get(computeTrustKey(entry))?.trustedHash === currentHash
              ? 'trusted'
              : 'untrusted',
          source: 'user',
          enabled: true
        }
      })
    )
  })
}

function start(): void {
  stop = startCodexHookReconcile({
    isEnabled: () => enabled,
    usesRealHome: () => true,
    resolveLaunchHome: () => (isCodexRealHomeLaneUsable() ? null : mirror())
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-safety-home-'))
  userData = mkdtempSync(join(tmpdir(), 'orca-codex-safety-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex 0.150.1')
  mocks.spies.beforeHooksJsonWrite = null
  mocks.spies.beforeBackup = null
  mocks.spies.backfill = 'not-pending'
  mocks.listCodexHooks.mockImplementation(async () => listLikeCodex())
  mocks.probeCodexVersion.mockResolvedValue({ version: 'codex-cli 0.150.1', timedOut: false })
  mocks.deriveCodexHookHashes.mockResolvedValue({
    codexVersion: 'codex-cli 0.150.1',
    hashes: computeCodexHookHashesForTests(),
    failure: null,
    transient: false
  })
  enabled = true
  _internals.resetForTesting()
})

afterEach(() => {
  stop?.()
  stop = null
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

describe('when ~/.codex cannot take the entry, launches use the managed home', () => {
  it('routes away while hooks.json is unreadable, says why, and comes back once it is fixed', async () => {
    mkdirSync(codexHome(), { recursive: true })
    writeFileSync(hooksPath(), '{ not json')
    start()

    await reconcileCodexHooks()

    expect(isCodexRealHomeLaneUsable()).toBe(false)
    expect(readFileSync(hooksPath(), 'utf-8')).toBe('{ not json')
    expect(new CodexHookService().getStatus()).toMatchObject({
      configPath: join(mirror(), 'hooks.json'),
      detail: expect.stringContaining("Orca's panes use Orca's own Codex home")
    })

    writeFileSync(hooksPath(), '{ "hooks": {} }\n')
    await reconcileCodexHooks()

    expect(isCodexRealHomeLaneUsable()).toBe(true)
    expect(getCodexRealHomeLaneProblem()).toBeNull()
  })

  it('stays on ~/.codex, with a plain reason, when Codex gives no hashes at all', async () => {
    mocks.deriveCodexHookHashes.mockResolvedValue({
      codexVersion: 'codex-cli 0.128.0',
      hashes: null,
      failure: 'Codex 0.128.0 is too old for Orca status; update Codex',
      transient: false
    })
    start()

    await reconcileCodexHooks()

    expect(isCodexRealHomeLaneUsable()).toBe(true)
    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'not_installed',
      detail: 'Codex 0.128.0 is too old for Orca status; update Codex'
    })
  })

  it.each([
    ['an inline hooks.state table', '[hooks]\nstate = { "x:stop:0:0" = { trusted_hash = "u" } }\n'],
    ['an inline hooks table', 'hooks = { state = {} }\n'],
    [
      "a dotted approval for Orca's own key",
      (): string => `hooks.state."${computeTrustKey(stopEntry())}".trusted_hash = "sha256:user"\n`
    ]
  ])('never writes a config.toml Codex would refuse: %s', async (_case, content) => {
    mkdirSync(codexHome(), { recursive: true })
    const original = `model = "m"\n${typeof content === 'string' ? content : content()}`
    writeFileSync(tomlPath(), original)
    start()

    await reconcileCodexHooks()

    expect(readFileSync(tomlPath(), 'utf-8')).toBe(original)
    expect(existsSync(hooksPath())).toBe(false)
    expect(getCodexRealHomeLaneProblem()).toContain('keeps hook approvals inline')
  })

  it('reads an approval written as dotted keys', () => {
    mkdirSync(codexHome(), { recursive: true })
    writeFileSync(
      tomlPath(),
      `hooks.state."${computeTrustKey(stopEntry())}".trusted_hash = "sha256:user"\n`
    )

    expect(readHookTrustEntries(tomlPath()).get(computeTrustKey(stopEntry()))).toEqual({
      trustedHash: 'sha256:user',
      enabled: undefined
    })
  })
})

describe('concurrent writers', () => {
  it("keeps a user's save between Orca's read and its write, and takes its approvals back", async () => {
    mkdirSync(codexHome(), { recursive: true })
    writeFileSync(hooksPath(), '{ "hooks": {} }\n')
    const userSave =
      '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "mine.sh" }] }] } }\n'
    mocks.spies.beforeBackup = () => writeFileSync(hooksPath(), userSave)
    start()

    await reconcileCodexHooks()

    expect(readFileSync(hooksPath(), 'utf-8')).toBe(userSave)
    expect(readHookTrustEntries(tomlPath()).get(computeTrustKey(stopEntry()))).toBeUndefined()
  })

  it("never restores over another writer's approval, and restores a switched-off key verbatim", async () => {
    mkdirSync(codexHome(), { recursive: true })
    const disabledOnly = `[hooks.state."${computeTrustKey(stopEntry())}"]\nenabled = false\n`
    writeFileSync(tomlPath(), disabledOnly)
    const sessionKey = computeTrustKey({ ...stopEntry(), eventLabel: 'session_start' })
    mocks.spies.beforeHooksJsonWrite = () => {
      upsertHookTrustEntries(tomlPath(), [
        { ...stopEntry(), eventLabel: 'session_start', trustedHash: 'sha256:other-writer' }
      ])
      throw new Error('disk full')
    }
    start()

    await reconcileCodexHooks()

    const trust = readHookTrustEntries(tomlPath())
    expect(trust.get(computeTrustKey(stopEntry()))).toEqual({
      trustedHash: undefined,
      enabled: false
    })
    expect(readFileSync(tomlPath(), 'utf-8')).toContain(disabledOnly.trim())
    expect(trust.get(sessionKey)?.trustedHash).toBe('sha256:other-writer')
  })
})

describe('the answer behind a binary', () => {
  it('re-probes a persisted binary once per process, so a shim retarget gets the new version', async () => {
    start()
    await reconcileCodexHooks()
    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
    // Why: a new process, the same shim bytes, a different codex behind them.
    _internals.resetForTesting()
    memoInternals.resetForTesting()
    mocks.probeCodexVersion.mockResolvedValue({ version: 'codex-cli 0.160.0', timedOut: false })
    start()

    await reconcileCodexHooks()

    expect(mocks.deriveCodexHookHashes).toHaveBeenLastCalledWith(
      mocks.codexPath,
      command(),
      'codex-cli 0.160.0'
    )
  })

  it('keeps an in-process answer when the memo file cannot be saved', async () => {
    writeFileSync(getCodexHookTrustMemoPath(), '{}')
    chmodSync(userData, 0o500)
    try {
      start()
      await reconcileCodexHooks()
      await reconcileCodexHooks()
    } finally {
      chmodSync(userData, 0o700)
    }

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it('re-asks Codex after hooks go off and on, even after a refusal', async () => {
    mocks.listCodexHooks.mockImplementation(async () =>
      listLikeCodex().map((listing) => ({ ...listing, trustStatus: 'modified', currentHash: 'x' }))
    )
    start()
    await reconcileCodexHooks()
    expect(isCodexRealHomeLaneUsable()).toBe(false)

    await new CodexHookService().remove()
    mocks.listCodexHooks.mockImplementation(async () => listLikeCodex())
    await new CodexHookService().reconcileHooks()

    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(2)
    expect(isCodexRealHomeLaneUsable()).toBe(true)
  })

  it('does not ask Codex about ~/.codex while its session index is rebuilding', async () => {
    mocks.spies.backfill = 'pending'
    start()

    await reconcileCodexHooks()

    expect(readHooks().Stop).toHaveLength(1)
    expect(mocks.listCodexHooks).not.toHaveBeenCalled()
  })
})

describe('both spellings of a symlinked ~/.codex', () => {
  it('approves under the spelled and the resolved key, and the opt-out removes both', async () => {
    const realCodexHome = join(home, 'dotfiles-codex')
    mkdirSync(realCodexHome)
    symlinkSync(realCodexHome, codexHome())
    const resolvedHooks = join(realpathSync(realCodexHome), 'hooks.json')
    start()

    await reconcileCodexHooks()

    const trust = readHookTrustEntries(tomlPath())
    const hash = computeCodexHookHashesForTests().stop
    expect(trust.get(computeTrustKey(stopEntry()))?.trustedHash).toBe(hash)
    expect(trust.get(computeTrustKey(stopEntry(resolvedHooks)))?.trustedHash).toBe(hash)

    await new CodexHookService().remove()

    const after = readHookTrustEntries(tomlPath())
    expect(after.get(computeTrustKey(stopEntry()))).toBeUndefined()
    expect(after.get(computeTrustKey(stopEntry(resolvedHooks)))).toBeUndefined()
  })

  it('resolves the key through a symlinked HOME before ~/.codex exists', async () => {
    const realHome = mkdtempSync(join(tmpdir(), 'orca-codex-safety-real-home-'))
    const linkedHome = join(home, 'linked-home')
    symlinkSync(realHome, linkedHome)
    mocks.homedir.mockReturnValue(linkedHome)
    try {
      start()

      await reconcileCodexHooks()

      const resolved = join(realpathSync(realHome), '.codex', 'hooks.json')
      expect(
        readHookTrustEntries(join(linkedHome, '.codex', 'config.toml')).get(
          computeTrustKey(stopEntry(resolved))
        )?.trustedHash
      ).toBe(computeCodexHookHashesForTests().stop)
    } finally {
      rmSync(realHome, { recursive: true, force: true })
    }
  })
})

describe('what a reconcile may spawn and when it waits', () => {
  it('asks nothing while hooks are off', async () => {
    enabled = false
    start()

    await reconcileCodexHooks()

    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
    expect(existsSync(codexHome())).toBe(false)
  })

  it('never asks Codex outside the app, reading only what the app learned', async () => {
    const answer = await resolveCodexHookHashes()

    expect(answer.failure).toBe('Orca has not asked Codex yet')
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
  })

  it('asks once for concurrent callers, and holds a timed-out probe back for a while', async () => {
    start()
    await reconcileCodexHooks()
    _internals.resetForTesting()
    memoInternals.resetForTesting()
    start()
    mocks.probeCodexVersion.mockClear()
    mocks.probeCodexVersion.mockResolvedValue({ version: null, timedOut: true })
    writeFileSync(mocks.codexPath, 'codex 0.150.1, rebuilt')

    await Promise.all([resolveCodexHookHashes(), resolveCodexHookHashes()])
    await resolveCodexHookHashes()

    expect(mocks.probeCodexVersion).toHaveBeenCalledTimes(1)
  })

  it('lets a launch go ahead without an answer that is still on its way', async () => {
    start()
    mocks.probeCodexVersion.mockImplementation(() => new Promise(() => {}))

    await expect(resolveCodexHookAnswerForLaunch(10)).resolves.toBeNull()
  })

  it('writes zero bytes when hooks turn on again with nothing changed', async () => {
    start()
    await reconcileCodexHooks()
    await new CodexHookService().reconcileHooks()
    const before = ['hooks.json', 'config.toml'].map((name) =>
      readFileSync(join(codexHome(), name), 'utf-8')
    )
    mocks.listCodexHooks.mockClear()

    await new CodexHookService().reconcileHooks()

    expect(
      ['hooks.json', 'config.toml'].map((name) => readFileSync(join(codexHome(), name), 'utf-8'))
    ).toEqual(before)
    expect(mocks.listCodexHooks).not.toHaveBeenCalled()
  })
})

describe('which home the post-write check reads', () => {
  it.each([
    ['win32', (): string => join(home, '.codex')],
    ['darwin', (): null => null]
  ] as const)('on %s it lists the home Orca wrote', async (platform, expectedHome) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      start()
      await reconcileCodexHooks()
    } finally {
      if (original) {
        Object.defineProperty(process, 'platform', original)
      }
    }

    expect(mocks.listCodexHooks).toHaveBeenCalledWith(
      mocks.codexPath,
      expectedHome(),
      expect.any(String)
    )
  })
})

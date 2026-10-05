import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as InstallerUtils from '../agent-hooks/installer-utils'
import type * as CodexCommand from '../codex-cli/command'
import type * as TrustDerivation from './codex-hook-trust-derivation'
import type { CodexHookListing } from './codex-app-server-client'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

const mocks = vi.hoisted(() => {
  const spies: { beforeHooksJsonWrite: (() => void) | null } = { beforeHooksJsonWrite: null }
  return {
    spies,
    homedir: vi.fn<() => string>(),
    codexPath: '',
    resolveCodexCommand: vi.fn<() => string>(),
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
  resolveCodexCommand: mocks.resolveCodexCommand
}))
vi.mock('./codex-hook-trust-derivation', async (importOriginal) => ({
  ...(await importOriginal<typeof TrustDerivation>()),
  probeCodexVersion: mocks.probeCodexVersion,
  deriveCodexHookHashes: mocks.deriveCodexHookHashes,
  listCodexHooks: mocks.listCodexHooks
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

import {
  _internals,
  isCodexRealHomeLaneUsable,
  reconcileCodexHooks,
  scheduleCodexHookReconcile,
  startCodexHookReconcile
} from './codex-hook-reconcile'
import { CodexHookService } from './codex-hook-service-implementation'
import { computeCodexHookHashesForTests } from './hook-service-test-harness'
import {
  buildCodexManagedHook,
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  getCodexManagedHookInstallMaterial
} from './codex-hook-definition'
import {
  computeTrustKey,
  computeTrustedHash,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'
import { fingerprintCodex, readCodexHookRealHomeRefusal } from './codex-hook-trust-memo'
import { CODEX_HOOK_EVENT_LABEL } from './codex-hook-identity'

let home: string
let userData: string
let enabled: boolean
let stop: (() => void) | null = null

const codexHome = (): string => join(home, '.codex')
const hooksPath = (): string => join(codexHome(), 'hooks.json')
const tomlPath = (): string => join(codexHome(), 'config.toml')
const command = (): string => getCodexManagedHookInstallMaterial().command

type Hooks = Record<string, { hooks: { type: string; command: string; timeout?: number }[] }[]>

function readHooks(): Hooks {
  return JSON.parse(readFileSync(hooksPath(), 'utf-8')).hooks
}

function writeHooks(hooks: Hooks): void {
  mkdirSync(codexHome(), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify({ hooks }, null, 2)}\n`)
}

function orcaKey(eventName: (typeof CODEX_EVENTS)[number], groupIndex: number): string {
  return computeTrustKey({
    sourcePath: hooksPath(),
    eventLabel: CODEX_EVENT_LABEL[eventName],
    groupIndex,
    handlerIndex: 0,
    command: command()
  })
}

/** Codex's own read of ~/.codex: each hook is trusted when its stored hash is the one Codex computes. */
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
          timeoutSec: hook.timeout
        }
        const state = trust.get(computeTrustKey(entry))
        const currentHash = computeTrustedHash(entry)
        return {
          key: computeTrustKey(entry),
          command: hook.command,
          currentHash,
          trustStatus: state?.trustedHash === currentHash ? 'trusted' : 'untrusted',
          source: 'user',
          enabled: state?.enabled !== false
        }
      })
    )
  })
}

function snapshot(dir: string): Map<string, { bytes: string; mtimeMs: number }> {
  return new Map(
    existsSync(dir)
      ? readdirSync(dir).map((name) => {
          const path = join(dir, name)
          return [name, { bytes: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs }]
        })
      : []
  )
}

function start(): void {
  stop = startCodexHookReconcile({
    isEnabled: () => enabled,
    usesRealHome: () => true,
    resolveLaunchHome: () => null
  })
}

function answerWith(hashes: CodexHookHashes, codexVersion = 'codex-cli 0.150.1'): void {
  mocks.probeCodexVersion.mockResolvedValue({ version: codexVersion, timedOut: false })
  mocks.deriveCodexHookHashes.mockResolvedValue({
    codexVersion,
    hashes,
    failure: null,
    transient: false
  })
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-home-'))
  userData = mkdtempSync(join(tmpdir(), 'orca-codex-reconcile-user-data-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', userData)
  vi.stubEnv('CODEX_HOME', '')
  mocks.homedir.mockReturnValue(home)
  mocks.codexPath = join(userData, 'codex')
  writeFileSync(mocks.codexPath, 'codex 0.150.1')
  mocks.resolveCodexCommand.mockImplementation(() => mocks.codexPath)
  mocks.spies.beforeHooksJsonWrite = null
  mocks.listCodexHooks.mockImplementation(async () => listLikeCodex())
  answerWith(computeCodexHookHashesForTests())
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

describe('reconcileCodexHooks', () => {
  it('writes the entry last in every listed event, with its approval enabled, and verifies it', async () => {
    writeHooks({ Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] })
    start()

    await reconcileCodexHooks()

    const hooks = readHooks()
    expect(Object.keys(hooks).sort()).toEqual([...CODEX_EVENTS].sort())
    expect(hooks.Stop!.map((group) => group.hooks[0]!.command)).toEqual(['user-stop.sh', command()])
    const trust = readHookTrustEntries(tomlPath())
    const hashes = computeCodexHookHashesForTests()
    expect(trust.get(orcaKey('Stop', 1))).toEqual({ trustedHash: hashes.stop, enabled: true })
    expect(trust.get(orcaKey('SessionStart', 0))?.trustedHash).toBe(hashes.session_start)
    expect(mocks.listCodexHooks).toHaveBeenCalledWith(mocks.codexPath, null, expect.any(String))
    expect(new CodexHookService().getStatus().state).toBe('installed')
  })

  it('writes the approval before the entry', async () => {
    start()
    const approvedAtEntryWrite: (string | undefined)[] = []
    mocks.spies.beforeHooksJsonWrite = () => {
      approvedAtEntryWrite.push(
        readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 0))?.trustedHash
      )
    }

    await reconcileCodexHooks()

    expect(approvedAtEntryWrite).toEqual([computeCodexHookHashesForTests().stop])
  })

  it('takes the approval back when the entry write fails', async () => {
    writeHooks({ Stop: [{ hooks: [{ type: 'command', command: 'user-stop.sh' }] }] })
    writeFileSync(tomlPath(), 'model = "user-model"\n')
    const before = snapshot(codexHome())
    mocks.spies.beforeHooksJsonWrite = () => {
      throw new Error('disk full')
    }
    start()

    await expect(reconcileCodexHooks()).resolves.toBeUndefined()

    expect(readFileSync(hooksPath(), 'utf-8')).toBe(before.get('hooks.json')!.bytes)
    expect(readHookTrustEntries(tomlPath()).size).toBe(0)
    expect(readFileSync(tomlPath(), 'utf-8')).toContain('model = "user-model"')
    expect(mocks.listCodexHooks).not.toHaveBeenCalled()
  })

  it('writes nothing and spawns nothing when nothing changed', async () => {
    start()
    await reconcileCodexHooks()
    const before = snapshot(codexHome())
    const memoBefore = snapshot(userData)
    vi.clearAllMocks()

    await reconcileCodexHooks()

    expect(snapshot(codexHome())).toEqual(before)
    expect(snapshot(userData)).toEqual(memoBefore)
    expect(mocks.probeCodexVersion).not.toHaveBeenCalled()
    expect(mocks.deriveCodexHookHashes).not.toHaveBeenCalled()
    expect(mocks.listCodexHooks).not.toHaveBeenCalled()
  })

  it('re-approves the entry after a user inserts a hook ahead of it, keeping user trust', async () => {
    start()
    await reconcileCodexHooks()
    const userPre: CodexTrustEntry = {
      sourcePath: hooksPath(),
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: 'user-pre.sh',
      trustedHash: 'sha256:user-approved'
    }
    const hooks = readHooks()
    hooks.Stop!.unshift({ hooks: [{ type: 'command', command: 'user-stop.sh' }] })
    hooks.PreToolUse!.unshift({ hooks: [{ type: 'command', command: 'user-pre.sh' }] })
    writeHooks(hooks)
    upsertHookTrustEntries(tomlPath(), [userPre])

    await reconcileCodexHooks()

    const trust = readHookTrustEntries(tomlPath())
    const hashes = computeCodexHookHashesForTests()
    expect(trust.get(orcaKey('Stop', 1))).toEqual({ trustedHash: hashes.stop, enabled: true })
    expect(trust.get(orcaKey('PreToolUse', 1))?.trustedHash).toBe(hashes.pre_tool_use)
    // Why: Orca's old slot now holds the user's new hook, which is theirs to review.
    expect(trust.get(orcaKey('Stop', 0))).toBeUndefined()
    expect(trust.get(computeTrustKey(userPre))?.trustedHash).toBe('sha256:user-approved')
    expect(readHooks().Stop!.map((group) => group.hooks[0]!.command)).toEqual([
      'user-stop.sh',
      command()
    ])
  })

  it('re-approves the unchanged entry with the new hash after a Codex update', async () => {
    start()
    await reconcileCodexHooks()
    const entryBytes = readFileSync(hooksPath(), 'utf-8')
    writeFileSync(mocks.codexPath, 'codex 0.160.0, a different binary')
    const newHashes = Object.fromEntries(
      Object.keys(computeCodexHookHashesForTests()).map((label) => [label, `sha256:new-${label}`])
    )
    answerWith(newHashes, 'codex-cli 0.160.0')
    mocks.listCodexHooks.mockImplementation(async () =>
      listLikeCodex().map((listing) => {
        const label = parseTrustKey(listing.key)?.eventLabel
        const state = readHookTrustEntries(tomlPath()).get(listing.key)
        return {
          ...listing,
          trustStatus: label && state?.trustedHash === newHashes[label] ? 'trusted' : 'modified'
        }
      })
    )

    await reconcileCodexHooks()

    expect(readFileSync(hooksPath(), 'utf-8')).toBe(entryBytes)
    expect(readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 0))?.trustedHash).toBe(
      'sha256:new-stop'
    )
    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(2)
  })

  it("turns Orca's entry back on after the user turned it off in /hooks", async () => {
    start()
    await reconcileCodexHooks()
    const stopKey = parseTrustKey(orcaKey('Stop', 0))!
    upsertHookTrustEntries(tomlPath(), [
      {
        ...stopKey,
        command: command(),
        trustedHash: computeCodexHookHashesForTests().stop,
        enabled: false
      }
    ])
    expect(readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 0))?.enabled).toBe(false)

    await reconcileCodexHooks()

    expect(readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 0))?.enabled).toBe(true)
  })

  it('writes nothing while hooks are off, and the opt-out removes the entry with its approval', async () => {
    enabled = false
    start()
    await reconcileCodexHooks()
    expect(existsSync(codexHome())).toBe(false)

    enabled = true
    await reconcileCodexHooks()
    expect(readHooks().Stop).toHaveLength(1)

    enabled = false
    await new CodexHookService().remove()

    expect(readHooks().Stop).toBeUndefined()
    expect([...readHookTrustEntries(tomlPath()).keys()]).toEqual([])
  })

  it("leaves an older build's events alone on a pane spawn, and converts them when hooks turn on", async () => {
    const older = {
      type: 'command',
      command: `/bin/sh '${join(home, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
    }
    const olderStop = [
      { hooks: [{ type: 'command', command: 'user-stop.sh' }] },
      { hooks: [older] }
    ]
    start()
    await reconcileCodexHooks()
    // Why after start's own conversion: an older build re-adds its entry while this one runs.
    writeHooks({ ...readHooks(), Stop: olderStop })
    mocks.resolveCodexCommand.mockClear()

    scheduleCodexHookReconcile()
    await vi.waitFor(() => expect(mocks.resolveCodexCommand).toHaveBeenCalled())
    await reconcileCodexHooks()

    // Why: a running older build may still own that entry; only app start or the setting converts it.
    expect(readHooks().Stop).toEqual(olderStop)
    expect(readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 1))).toBeUndefined()
    // Why still written elsewhere: this build re-adds and approves its own entry in every other event.
    expect(readHookTrustEntries(tomlPath()).get(orcaKey('SessionStart', 0))?.enabled).toBe(true)

    await new CodexHookService().reconcileHooks()

    expect(readHooks().Stop!.map((group) => group.hooks[0]!.command)).toEqual([
      'user-stop.sh',
      command()
    ])
    expect(readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 1))?.enabled).toBe(true)
  })

  it('keeps a conversion asked for while hooks were off until one actually runs', async () => {
    const older = {
      type: 'command',
      command: `/bin/sh '${join(home, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
    }
    writeHooks({ Stop: [{ hooks: [older] }] })
    enabled = false
    start()
    await reconcileCodexHooks({ convertOlderForms: true })
    enabled = true

    await reconcileCodexHooks()

    expect(readHooks().Stop).toEqual([{ hooks: [buildCodexManagedHook(command(), 'Stop')] }])
  })

  it('adds nothing to ~/.codex while launches use a managed home, yet re-approves an entry there', async () => {
    let realHome = false
    stop = startCodexHookReconcile({
      isEnabled: () => true,
      usesRealHome: () => realHome,
      resolveLaunchHome: () => null
    })

    await reconcileCodexHooks()
    expect(existsSync(codexHome())).toBe(false)

    realHome = true
    await reconcileCodexHooks()
    realHome = false
    const hooks = readHooks()
    delete hooks.SessionStart
    hooks.Stop!.unshift({ hooks: [{ type: 'command', command: 'user-stop.sh' }] })
    writeHooks(hooks)

    await reconcileCodexHooks()

    // Why: a Codex run outside Orca still reads ~/.codex, so a shifted entry stays approved.
    expect(readHookTrustEntries(tomlPath()).get(orcaKey('Stop', 1))?.enabled).toBe(true)
    expect(readHooks().SessionStart).toBeUndefined()
  })

  it('gives an entry only to the events this Codex lists', async () => {
    const all = computeCodexHookHashesForTests()
    const listed: CodexHookHashes = {
      session_start: all.session_start,
      user_prompt_submit: all.user_prompt_submit,
      pre_tool_use: all.pre_tool_use,
      permission_request: all.permission_request,
      post_tool_use: all.post_tool_use,
      stop: all.stop
    }
    answerWith(listed, 'codex-cli 0.131.0')
    start()

    await reconcileCodexHooks()

    expect(Object.keys(readHooks()).sort()).toEqual(
      [
        'PermissionRequest',
        'PostToolUse',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'UserPromptSubmit'
      ].sort()
    )
    expect(
      new Set(
        [...readHookTrustEntries(tomlPath()).keys()].map((key) => parseTrustKey(key)?.eventLabel)
      )
    ).toEqual(new Set(Object.keys(listed)))
  })

  it('writes nothing for a Codex without hooks/list, and says so in status', async () => {
    mocks.deriveCodexHookHashes.mockResolvedValue({
      codexVersion: 'codex-cli 0.128.0',
      hashes: null,
      failure: 'Codex 0.128.0 is too old for Orca status; update Codex',
      transient: false
    })
    start()

    await reconcileCodexHooks()
    await reconcileCodexHooks()

    expect(existsSync(codexHome())).toBe(false)
    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(1)
    expect(new CodexHookService().getStatus()).toMatchObject({
      state: 'not_installed',
      detail: expect.stringContaining('update Codex')
    })
  })

  it('withdraws an entry Codex hashes differently, and stops writing ~/.codex for that binary', async () => {
    mocks.listCodexHooks.mockImplementation(async () =>
      listLikeCodex().map((listing) => ({
        ...listing,
        trustStatus: 'modified',
        currentHash: 'sha256:codex-hashes-it-otherwise'
      }))
    )
    start()

    await reconcileCodexHooks()

    expect(readHooks().Stop).toBeUndefined()
    expect(readHookTrustEntries(tomlPath()).size).toBe(0)
    expect(
      readCodexHookRealHomeRefusal(
        mocks.codexPath,
        fingerprintCodex(mocks.codexPath),
        'codex-cli 0.150.1'
      )
    ).toContain("did not accept Orca's approval")
    expect(isCodexRealHomeLaneUsable()).toBe(false)

    vi.clearAllMocks()
    await reconcileCodexHooks()
    expect(readHooks().Stop).toBeUndefined()
    expect(mocks.deriveCodexHookHashes).not.toHaveBeenCalled()
    expect(mocks.listCodexHooks).not.toHaveBeenCalled()
  })

  it('writes again, once, when another writer dropped the approval it just wrote', async () => {
    mocks.listCodexHooks.mockImplementationOnce(async () => {
      // Why: another writer saves its own copy of config.toml, without Orca's approvals.
      const listings = listLikeCodex()
      writeFileSync(tomlPath(), 'model = "user-model"\n')
      return listings.map((listing) => ({ ...listing, trustStatus: 'untrusted' }))
    })
    start()

    await reconcileCodexHooks()

    // Why: the listing hashed the entry as approved, so the approval was lost, not refused.
    expect(mocks.listCodexHooks).toHaveBeenCalledTimes(2)
    expect(readHooks().Stop).toHaveLength(1)
    expect(
      readCodexHookRealHomeRefusal(
        mocks.codexPath,
        fingerprintCodex(mocks.codexPath),
        'codex-cli 0.150.1'
      )
    ).toBeNull()
    expect(isCodexRealHomeLaneUsable()).toBe(true)
  })

  it.each([
    ['config.toml', tomlPath],
    ['hooks.json', hooksPath]
  ])('never throws when %s cannot be read', async (_name, path) => {
    mkdirSync(path(), { recursive: true })
    start()

    await expect(reconcileCodexHooks()).resolves.toBeUndefined()
    expect(new CodexHookService().getStatus().state).not.toBe('installed')
  })

  it('runs again for a change made while a run was in flight', async () => {
    start()
    let releaseVerify!: () => void
    mocks.listCodexHooks.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseVerify = resolve
      })
      return listLikeCodex()
    })
    const first = reconcileCodexHooks()
    await vi.waitFor(() => expect(mocks.listCodexHooks).toHaveBeenCalledTimes(1))

    const hooks = readHooks()
    delete hooks.Stop
    writeHooks(hooks)
    const second = reconcileCodexHooks()
    releaseVerify()
    await Promise.all([first, second])

    expect(readHooks().Stop).toHaveLength(1)
    expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(1)
  })

  it('reconciles once for a burst of pane spawns', async () => {
    start()
    await reconcileCodexHooks()
    const hooks = readHooks()
    delete hooks.Stop
    writeHooks(hooks)
    mocks.resolveCodexCommand.mockClear()

    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    await vi.waitFor(() => expect(readHooks().Stop).toHaveLength(1))
    await reconcileCodexHooks()
    mocks.resolveCodexCommand.mockClear()
    scheduleCodexHookReconcile()
    scheduleCodexHookReconcile()
    await new Promise((resolve) => setImmediate(resolve))
    await reconcileCodexHooks()

    // Why 2: one run for the burst, one for the explicit call after it.
    expect(mocks.resolveCodexCommand).toHaveBeenCalledTimes(2)
  })

  it('writes nothing when hooks turn off while Codex is being asked', async () => {
    start()
    let releaseDerive!: () => void
    mocks.deriveCodexHookHashes.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseDerive = resolve
      })
      return {
        codexVersion: 'codex-cli 0.150.1',
        hashes: computeCodexHookHashesForTests(),
        failure: null,
        transient: false
      }
    })
    const run = reconcileCodexHooks()
    await vi.waitFor(() => expect(mocks.deriveCodexHookHashes).toHaveBeenCalledTimes(1))

    enabled = false
    releaseDerive()
    await run

    expect(existsSync(codexHome())).toBe(false)
  })
})

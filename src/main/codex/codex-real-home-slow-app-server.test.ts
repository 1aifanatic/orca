import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { dirname, join } from 'node:path'
import type { HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import {
  CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS,
  _internals as grantInternals
} from './codex-hook-trust-grant'
import {
  computeTrustedHash,
  computeTrustKey,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries
} from './config-toml-trust'
import { isCodexManagedCommand, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock, resolveCodexCommandMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>(),
  resolveCodexCommandMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))

import {
  _internals as realHomeInternals,
  ensureRealHomeCodexHookState,
  isRealHomeCodexHookLaneUsable,
  removeRealHomeCodexHookForOptOut
} from './codex-real-home-hook-install'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { readOrcaEntryTrust } from './codex-real-home-entry-trust'

// Why this file (QA case 4): a cold `codex app-server` on a loaded Mac took over
// 10 s. A launch must never wait on that approval, the approval must still land,
// and a failed one must not block the next try for minutes.

const homes = setupCodexHookHomes(homedirMock, getPathMock)
const USER_HOOK: HookDefinition = { hooks: [{ type: 'command', command: 'user-hook.sh' }] }

function hooksPath(): string {
  return join(homes.tmpHome, '.codex', 'hooks.json')
}

function configPath(): string {
  return join(homes.tmpHome, '.codex', 'config.toml')
}

function readHooks(): Record<string, HookDefinition[]> {
  const file: { hooks: Record<string, HookDefinition[]> } = JSON.parse(
    readFileSync(hooksPath(), 'utf-8')
  )
  return file.hooks
}

function orcaHandlerCount(): number {
  return Object.values(readHooks())
    .flat()
    .flatMap((definition) => definition.hooks ?? [])
    .filter((hook) => isCodexManagedCommand(hook.command)).length
}

function orcaEntryTrust(): string[] {
  const trust = readHookTrustEntries(configPath())
  return Object.entries(readHooks()).flatMap(([eventName, definitions]) =>
    definitions.flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) => {
        if (!isCodexManagedCommand(hook.command)) {
          return []
        }
        const entry = createCodexHookTrustEntry(
          hooksPath(),
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        return [entry ? readOrcaEntryTrust(entry, trust) : 'untrusted']
      })
    )
  )
}

type AppServer = { sessions: number; start: () => void }

/**
 * An app-server whose start takes `coldStartMs`, ending when `start()` is called.
 * Past the session deadline it times out, as the real session does.
 */
function installAppServer(coldStartMs: number, failure?: Error): AppServer {
  let start: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    start = resolve
  })
  const server: AppServer = { sessions: 0, start: () => start() }
  grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
    server.sessions += 1
    await started
    if (coldStartMs > request.invocation.timeoutMs) {
      throw new CodexAppServerTimeoutError(
        `codex app-server session exceeded ${request.invocation.timeoutMs}ms`
      )
    }
    if (failure) {
      throw failure
    }
    const entries = request.expectedTrustKeys.map((key) => {
      const entry = { ...parseTrustKey(key)!, command: request.managedCommand, timeoutSec: 10 }
      return { key, entry, trustedHash: computeTrustedHash(entry) }
    })
    upsertHookTrustEntries(
      configPath(),
      entries.map(({ entry, trustedHash }) => ({ ...entry, trustedHash }))
    )
    return {
      outcome: 'granted' as const,
      wroteTrust: true,
      entries: entries.map(({ key, trustedHash }) => ({
        key,
        normalizedKey: normalizeHookTrustKeyForLookup(key),
        trustedHash
      }))
    }
  })
  return server
}

function launch(): ReturnType<typeof ensureRealHomeCodexHookState> {
  return ensureRealHomeCodexHookState({
    hooksEnabled: true,
    userDataPath: homes.userDataDir,
    writePolicy: 'add-missing-only'
  })
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  realHomeInternals.setLaneForTesting('pending')
  resolveCodexCommandMock.mockReturnValue(process.execPath)
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify({ hooks: { Stop: [USER_HOOK] } }, null, 2)}\n`)
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a slow codex app-server start', () => {
  it('never holds up a launch: a 15 s start grants in the background for the next launch', async () => {
    const server = installAppServer(15_000)

    const startedAt = performance.now()
    expect(await launch()).toBe('granting')
    expect(await launch()).toBe('granting')
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    // Why: a launch that finds trust not ready uses the managed home.
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
    expect(orcaHandlerCount()).toBe(getCodexManagedHookInstallMaterial().events.length)

    server.start()
    expect(await realHomeInternals.settledLaneForTesting()).toBe('installed')

    expect(await launch()).toBe('installed')
    expect(isRealHomeCodexHookLaneUsable()).toBe(true)
    expect(server.sessions).toBe(1)
  })

  it('starts no cooldown after a timeout: the next launch tries again at once', async () => {
    const hung = installAppServer(10 * 60_000)
    hung.start()

    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')
    // Why: the failed attempt takes back its own unapproved adds, so nothing asks for review.
    expect(orcaHandlerCount()).toBe(0)
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`withdrew ${events} unapproved entries .*retrying on the next launch$`)
      )
    )

    const recovered = installAppServer(0)
    recovered.start()
    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('installed')
    expect(recovered.sessions).toBe(1)
  })

  it('runs one session at a time, ended by its own deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const spawnMs = 500
    let inFlight = 0
    let maxInFlight = 0
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        // Why: the real session starts its kill timer once the app-server has spawned.
        await new Promise((resolve) => setTimeout(resolve, spawnMs))
        return await new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new CodexAppServerTimeoutError('codex app-server session timed out')),
            request.invocation.timeoutMs
          )
        )
      } finally {
        inFlight -= 1
      }
    })

    expect(await launch()).toBe('granting')
    await vi.advanceTimersByTimeAsync(CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS)
    // Why: the session is still alive, so a launch now must not start a second one.
    expect(await launch()).toBe('granting')
    await vi.advanceTimersByTimeAsync(spawnMs)
    expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')
    expect(maxInFlight).toBe(1)
    expect(orcaHandlerCount()).toBe(0)
  })

  it('keeps already-trusted Orca entries trusted when a later re-grant fails', async () => {
    installAppServer(0).start()
    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('installed')
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(orcaEntryTrust()).toEqual(Array(events).fill('trusted'))

    // Why a ledger miss: another Orca profile keeps its own ledger for this shared home.
    rmSync(join(dirname(getOrcaManagedCodexHomePath()), 'trust-grant-ledger.json'))
    realHomeInternals.setLaneForTesting('pending')
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    failing.start()
    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')

    expect(failing.sessions).toBe(1)
    expect(orcaEntryTrust()).toEqual(Array(events).fill('trusted'))
  })

  it('backs off for seconds, not minutes, after any other failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    failing.start()

    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')
    expect(await launch()).toBe('unavailable')
    expect(failing.sessions).toBe(1)

    vi.setSystemTime(Date.now() + 10_001)
    expect(await launch()).toBe('granting')
    await realHomeInternals.settledLaneForTesting()
    expect(failing.sessions).toBe(2)
  })

  it('re-adds the entry when hooks go off and on during an approval, one session at a time', async () => {
    const server = installAppServer(0)
    const events = getCodexManagedHookInstallMaterial().events.length
    expect(await launch()).toBe('granting')
    expect(await removeRealHomeCodexHookForOptOut()).toBe('removed')
    expect(orcaHandlerCount()).toBe(0)

    expect(await launch()).toBe('granting')
    expect(orcaHandlerCount()).toBe(events)
    expect(isRealHomeCodexHookLaneUsable()).toBe(false)
    // Why: the second approval waits for the first session to end.
    expect(server.sessions).toBe(1)

    server.start()
    expect(await realHomeInternals.settledLaneForTesting()).toBe('installed')
    expect(orcaEntryTrust()).toEqual(Array(events).fill('trusted'))
  })

  it('has one retry schedule: turning hooks off and on after a failure retries at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const failing = installAppServer(
      0,
      new Error('codex app-server exited before completing the session')
    )
    failing.start()
    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')

    await ensureRealHomeCodexHookState({
      hooksEnabled: false,
      userDataPath: homes.userDataDir,
      writePolicy: 'add-missing-only'
    })
    const recovered = installAppServer(0)
    recovered.start()
    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('installed')
    expect(recovered.sessions).toBe(1)
  })

  it.skipIf(process.platform === 'win32')(
    'removes a retired entry and moves the user trust behind it with no Codex session',
    async () => {
      const hung = installAppServer(10 * 60_000)
      hung.start()
      const script = `'${join(homes.tmpHome, '.orca', 'agent-hooks', 'codex-hook.sh')}'`
      const retired = {
        hooks: [{ type: 'command', command: `if [ -x ${script} ]; then /bin/sh ${script}; fi` }]
      }
      writeFileSync(
        hooksPath(),
        `${JSON.stringify({ hooks: { Stop: [retired, USER_HOOK] } }, null, 2)}\n`
      )
      const userAt = (groupIndex: number) => ({
        sourcePath: hooksPath(),
        eventLabel: 'stop' as const,
        groupIndex,
        handlerIndex: 0,
        command: 'user-hook.sh'
      })
      upsertHookTrustEntries(configPath(), [{ ...userAt(1), trustedHash: 'sha256:user-approved' }])

      expect(await launch()).toBe('granting')
      expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')
      await cleanupLegacySystemManagedHooks()

      expect(readHooks().Stop).toEqual([USER_HOOK])
      const trust = readHookTrustEntries(configPath())
      expect(trust.get(computeTrustKey(userAt(0)))?.trustedHash).toBe('sha256:user-approved')
      // Why: the one session is the launch's grant; the removal started none.
      expect(hung.sessions).toBe(1)
    }
  )
})

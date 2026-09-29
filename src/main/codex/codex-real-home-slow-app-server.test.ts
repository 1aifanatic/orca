import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
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
  awaitRealHomeCodexHookTrust,
  ensureRealHomeCodexHookState,
  isRealHomeCodexHookLaneUsable
} from './codex-real-home-hook-install'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'

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

  it('lets a resume into the real home wait for the grant, but only as long as allowed', async () => {
    const server = installAppServer(15_000)
    expect(await launch()).toBe('granting')

    const startedAt = performance.now()
    expect(await awaitRealHomeCodexHookTrust(50)).toBe('granting')
    expect(performance.now() - startedAt).toBeLessThan(1_000)

    server.start()
    expect(await awaitRealHomeCodexHookTrust(60_000)).toBe('installed')
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

  it('settles a grant that never answers at its deadline, and the next launch retries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // Why never started: the hang outlives the session's own timeout, as a stuck probe would.
    installAppServer(0)

    expect(await launch()).toBe('granting')
    await vi.advanceTimersByTimeAsync(CODEX_BACKGROUND_TRUST_GRANT_TIMEOUT_MS)
    expect(await realHomeInternals.settledLaneForTesting()).toBe('unavailable')
    expect(orcaHandlerCount()).toBe(0)

    const recovered = installAppServer(0)
    recovered.start()
    expect(await launch()).toBe('granting')
    expect(await realHomeInternals.settledLaneForTesting()).toBe('installed')
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import type { HookDefinition } from '../agent-hooks/installer-utils'
import type { CodexHookTrustGrantRequest } from './codex-app-server-client'
import { CodexAppServerTimeoutError } from './codex-app-server-session'
import { _internals as grantInternals } from './codex-hook-trust-grant'
import {
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  computeTrustKey,
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
  ensureRealHomeCodexHookState
} from './codex-real-home-hook-install'
import { cleanupLegacySystemManagedHooks } from './codex-hook-legacy-cleanup'

// Why this file (QA case 4): a cold `codex app-server` on a loaded Mac took over
// 10 s. That start must still grant, and a session that does time out must not
// block the grant for minutes afterwards.

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

/** An app-server whose start takes `coldStartMs`; past the session deadline it times out, as the real session does. */
function installAppServerWithColdStart(coldStartMs: number): { sessions: number } {
  const counts = { sessions: 0 }
  grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
    counts.sessions += 1
    if (coldStartMs > request.invocation.timeoutMs) {
      throw new CodexAppServerTimeoutError(
        `codex app-server session exceeded ${request.invocation.timeoutMs}ms`
      )
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
  return counts
}

function ensureOnLaunch(): ReturnType<typeof ensureRealHomeCodexHookState> {
  return ensureRealHomeCodexHookState({
    hooksEnabled: true,
    userDataPath: homes.userDataDir,
    writePolicy: 'add-missing-only'
  })
}

beforeEach(() => {
  realHomeInternals.setLaneForTesting('pending')
  resolveCodexCommandMock.mockReturnValue(process.execPath)
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  writeFileSync(hooksPath(), `${JSON.stringify({ hooks: { Stop: [USER_HOOK] } }, null, 2)}\n`)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a slow codex app-server start', () => {
  it('still grants when the cold start takes 15 s, and the entry stays added', async () => {
    const counts = installAppServerWithColdStart(15_000)

    expect(await ensureOnLaunch()).toBe('installed')

    expect(counts.sessions).toBe(1)
    expect(orcaHandlerCount()).toBeGreaterThan(0)
    expect(readHookTrustEntries(configPath()).size).toBe(orcaHandlerCount())
  })

  it('retries on the next launch after a session times out, with no cooldown', async () => {
    const counts = installAppServerWithColdStart(10 * 60_000)

    expect(await ensureOnLaunch()).toBe('unavailable')
    // Why: a withdrawn entry leaves nothing for Codex to list for review.
    expect(orcaHandlerCount()).toBe(0)

    const retry = installAppServerWithColdStart(0)
    expect(await ensureOnLaunch()).toBe('installed')

    expect(counts.sessions).toBe(1)
    expect(retry.sessions).toBe(1)
    expect(orcaHandlerCount()).toBeGreaterThan(0)
  })

  it('runs one follow-up session for launches that queue behind a slow one', async () => {
    let finishFirst: () => void = () => {}
    const counts = { sessions: 0 }
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      counts.sessions += 1
      if (counts.sessions === 1) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve
        })
      }
      throw new CodexAppServerTimeoutError(
        `codex app-server session exceeded ${request.invocation.timeoutMs}ms`
      )
    })

    const first = ensureOnLaunch()
    await vi.waitFor(() => expect(counts.sessions).toBe(1))
    const queued = [ensureOnLaunch(), ensureOnLaunch(), ensureOnLaunch()]
    finishFirst()

    expect(await first).toBe('unavailable')
    expect(await Promise.all(queued)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(counts.sessions).toBe(2)
  })

  it.skipIf(process.platform === 'win32')(
    'removes a retired entry and moves the user trust behind it while every session times out',
    async () => {
      const counts = installAppServerWithColdStart(10 * 60_000)
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

      expect(await ensureOnLaunch()).toBe('unavailable')
      await cleanupLegacySystemManagedHooks()

      expect(readHooks().Stop).toEqual([USER_HOOK])
      const trust = readHookTrustEntries(configPath())
      expect(trust.get(computeTrustKey(userAt(0)))?.trustedHash).toBe('sha256:user-approved')
      expect(counts.sessions).toBe(1)
    }
  )
})

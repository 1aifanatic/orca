import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HookDefinition } from '../agent-hooks/installer-utils'
import type {
  CodexHookTrustGrantRequest,
  CodexHookTrustGrantSessionResult
} from '../codex/codex-app-server-client'
import { CodexAppServerTimeoutError } from '../codex/codex-app-server-session'
import { isCodexManagedCommand, setupCodexHookHomes } from '../codex/hook-service-test-harness'

// Why this file (QA case 4, full launch path): Codex's approval of the real-home
// entry runs in the background. A launch during it goes to the managed home and
// waits only on that home's own setup, which is bounded by its inline approval.
// A resume has no other home, so it starts at once.

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
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return { ...actual, homedir: homedirMock }
})
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: resolveCodexCommandMock }))
vi.mock('../wsl', () => ({ getDefaultWslDistro: () => 'Ubuntu' }))
vi.mock('../codex/codex-legacy-session-resume', () => ({
  prepareLegacySharedCodexSessionResume: async () => ({ useRealCodexHome: false })
}))
// Why: provenance is verified elsewhere; this resumes a session found in the real home.
vi.mock('../codex/codex-session-resume-preparation', async () => {
  const { getSystemCodexHomePath } = await import('../codex/codex-home-paths')
  return {
    prepareCodexSessionResume: async (args: {
      resolveVerifiedResumeHome: (source: {
        homePath: string
        transcriptPath: string
      }) => Promise<string>
    }) => {
      const homePath = getSystemCodexHomePath()
      const codexHomePath = await args.resolveVerifiedResumeHome({
        homePath,
        transcriptPath: join(homePath, 'sessions', 'abc.jsonl')
      })
      return { outcome: 'resume', codexHomePath, sessionId: 'abc' }
    }
  }
})
// Why: the real predicate, without loading every agent's hook service.
vi.mock(
  '../agent-hooks/managed-agent-hook-controls',
  async () => await import('../../shared/agent-status-hooks-setting')
)
vi.mock('./main-process-state', async () => {
  const { isRealHomeCodexHookLaneUsable } = await import('../codex/codex-real-home-hook-install')
  const { getOrcaManagedCodexHomePath } = await import('../codex/codex-home-paths')
  return {
    mainProcessState: {
      codexRuntimeHome: {
        isHostSystemDefaultRealHomeSelected: () => true,
        isHostSystemDefaultRealHome: () => isRealHomeCodexHookLaneUsable(),
        getHostCodexHomePathsForSessionDiscovery: () => [],
        resolveSelectedHostAccountCodexHomePathForResume: () => null,
        // Why: the runtime home service's lane gate, reduced to its verdict.
        prepareForCodexLaunchAsync: async () =>
          isRealHomeCodexHookLaneUsable() ? null : getOrcaManagedCodexHomePath()
      },
      store: { getSettings: () => ({ agentStatusHooksEnabled: true, disabledTuiAgents: [] }) }
    }
  }
})

const { _internals: grantInternals } = await import('../codex/codex-hook-trust-grant')
const { _internals: realHomeInternals } = await import('../codex/codex-real-home-hook-install')
const { getOrcaManagedCodexHomePath } = await import('../codex/codex-home-paths')
const { prepareCodexRuntimeHomeForLaunch } = await import('./codex-launch-preparation')
const { prepareCodexSessionResumeForLaunch } = await import('./codex-session-resume-launch')
const {
  computeTrustedHash,
  normalizeHookTrustKeyForLookup,
  parseTrustKey,
  readHookTrustEntries,
  upsertHookTrustEntries
} = await import('../codex/config-toml-trust')
const { createCodexHookTrustEntry } = await import('../codex/codex-hook-identity')
const { readOrcaEntryTrust } = await import('../codex/codex-real-home-entry-trust')

const homes = setupCodexHookHomes(homedirMock, getPathMock)

function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** What codex app-server does once it answers: approves every expected entry. */
function approveAll(request: CodexHookTrustGrantRequest): CodexHookTrustGrantSessionResult {
  const entries = request.expectedTrustKeys.map((key) => {
    const entry = { ...parseTrustKey(key)!, command: request.managedCommand, timeoutSec: 10 }
    return { key, entry, trustedHash: computeTrustedHash(entry) }
  })
  upsertHookTrustEntries(
    join(request.hooksListCwd, 'config.toml'),
    entries.map(({ entry, trustedHash }) => ({ ...entry, trustedHash }))
  )
  return {
    outcome: 'granted',
    wroteTrust: true,
    entries: entries.map(({ key, trustedHash }) => ({
      key,
      normalizedKey: normalizeHookTrustKeyForLookup(key),
      trustedHash
    }))
  }
}

function isRealHomeSession(request: CodexHookTrustGrantRequest): boolean {
  return request.invocation.envToDelete?.includes('CODEX_HOME') === true
}

function workspaceDirs(): string[] {
  return ['one', 'two'].map((name) => {
    const path = join(homes.tmpHome, name)
    mkdirSync(path, { recursive: true })
    return path
  })
}

/** How Codex will treat each Orca entry in the real ~/.codex/hooks.json. */
function realHomeOrcaEntryTrust(): string[] {
  const hooksPath = join(homes.tmpHome, '.codex', 'hooks.json')
  const hooks: Record<string, HookDefinition[]> = JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks
  const trust = readHookTrustEntries(join(homes.tmpHome, '.codex', 'config.toml'))
  return Object.entries(hooks).flatMap(([eventName, definitions]) =>
    definitions.flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) => {
        if (!isCodexManagedCommand(hook.command)) {
          return []
        }
        const entry = createCodexHookTrustEntry(
          hooksPath,
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

function resume(): Promise<unknown> {
  return prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: 'abc' },
    target: { runtime: 'host' }
  })
}

function launch(workspacePath: string): Promise<string | null> {
  return prepareCodexRuntimeHomeForLaunch(undefined, undefined, {
    launchAgent: 'codex',
    workspacePath
  })
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  realHomeInternals.setLaneForTesting('pending')
  resolveCodexCommandMock.mockReturnValue(process.execPath)
  mkdirSync(join(homes.tmpHome, '.codex'), { recursive: true })
  writeFileSync(join(homes.tmpHome, '.codex', 'hooks.json'), '{"hooks":{}}\n')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('a Codex launch while the real-home approval hangs', () => {
  it('settles on the managed home with its hooks and the project trust written', async () => {
    let release: () => void = () => {}
    const hung = new Promise<void>((resolve) => {
      release = resolve
    })
    let realHomeSessions = 0
    let managedSessions = 0
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      if (isRealHomeSession(request)) {
        realHomeSessions += 1
        await hung
        throw new Error('codex app-server exited before completing the session')
      }
      managedSessions += 1
      return approveAll(request)
    })
    const workspaces = workspaceDirs()

    try {
      const first = launch(workspaces[0])
      expect(await settlesWithin(first, 2_000)).toBe(true)
      expect(await first).toBe(getOrcaManagedCodexHomePath())
      const second = launch(workspaces[1])
      expect(await settlesWithin(second, 2_000)).toBe(true)
      expect(await second).toBe(getOrcaManagedCodexHomePath())
      expect(realHomeSessions).toBe(1)
      // Why: the second launch finds the managed home's approval in its ledger.
      expect(managedSessions).toBe(1)

      const managedHooks = readFileSync(join(getOrcaManagedCodexHomePath(), 'hooks.json'), 'utf-8')
      expect(managedHooks).toContain('codex-hook')
      const systemConfig = readFileSync(join(homes.tmpHome, '.codex', 'config.toml'), 'utf-8')
      for (const workspace of workspaces) {
        expect(systemConfig).toContain(workspace)
      }
      expect(systemConfig.match(/trust_level = "trusted"/g)).toHaveLength(2)
    } finally {
      release()
      await realHomeInternals.settledLaneForTesting()
    }
  })

  it("waits up to the managed home's own 10 s approval when that home is cold too", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let release: () => void = () => {}
    const hung = new Promise<void>((resolve) => {
      release = resolve
    })
    const managedTimeouts: number[] = []
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      if (isRealHomeSession(request)) {
        await hung
        throw new Error('codex app-server exited before completing the session')
      }
      managedTimeouts.push(request.invocation.timeoutMs)
      // Why: as the real session does, a cold app-server fails at its own deadline.
      return new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new CodexAppServerTimeoutError('codex app-server session timed out')),
          request.invocation.timeoutMs
        )
      )
    })
    const workspaces = workspaceDirs()

    try {
      let firstSettled = false
      const first = launch(workspaces[0]).finally(() => {
        firstSettled = true
      })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(firstSettled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(firstSettled).toBe(true)
      expect(await first).toBe(getOrcaManagedCodexHomePath())
      expect(managedTimeouts).toEqual([10_000])

      // Why: the managed home's failed approval cools down for 5 minutes, so the next launch does not wait.
      let secondSettled = false
      const second = launch(workspaces[1]).finally(() => {
        secondSettled = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(secondSettled).toBe(true)
      expect(await second).toBe(getOrcaManagedCodexHomePath())
      expect(managedTimeouts).toEqual([10_000])
    } finally {
      release()
      // Why: a failed assertion must not leave a managed session holding the lane.
      await vi.advanceTimersByTimeAsync(60_000)
      await realHomeInternals.settledLaneForTesting()
    }
  })
})

describe('a Codex resume into the real ~/.codex while its approval runs', () => {
  it('starts at once, and the entry is approved when the grant lands', async () => {
    let approve: () => void = () => {}
    const approval = new Promise<void>((resolve) => {
      approve = resolve
    })
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      await approval
      return approveAll(request)
    })

    expect(await settlesWithin(resume(), 200)).toBe(true)
    approve()
    await realHomeInternals.settledLaneForTesting()
    const trust = realHomeOrcaEntryTrust()
    expect(trust.length).toBeGreaterThan(0)
    expect(trust.every((state) => state === 'trusted')).toBe(true)
  })
})

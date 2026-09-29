import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexHookTrustGrantRequest } from '../codex/codex-app-server-client'
import type { CodexSessionResumePreparation } from '../codex/codex-session-resume-home'
import type { CodexTrustEntry } from '../codex/config-toml-trust'
import { isCodexManagedCommand, setupCodexHookHomes } from '../codex/hook-service-test-harness'

// Why this file (QA case 4, full launch path): Codex's approval of the real-home
// entry runs in the background. A launch during it must settle on the managed
// home at once, with that home's hook install and the project trust write done.
// A resume has no other home, so it spawns at once and trusts Orca's entries for itself.

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
const { codexAppServerCapabilityCache, getCodexAppServerHostKey } =
  await import('../codex/codex-app-server-capability-cache')
const { _internals: realHomeInternals } = await import('../codex/codex-real-home-hook-install')
const { getOrcaManagedCodexHomePath } = await import('../codex/codex-home-paths')
const { prepareCodexRuntimeHomeForLaunch } = await import('./codex-launch-preparation')
const { prepareCodexSessionResumeForLaunch } = await import('./codex-session-resume-launch')
const {
  computeTrustedHash,
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
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

type HookDefinition = {
  hooks?: { command?: string }[]
}

/** Orca's entries in the real ~/.codex/hooks.json. */
function realHomeOrcaEntries(): CodexTrustEntry[] {
  const hooksPath = join(homes.tmpHome, '.codex', 'hooks.json')
  const hooks: Record<string, HookDefinition[]> = JSON.parse(readFileSync(hooksPath, 'utf-8')).hooks
  return Object.entries(hooks).flatMap(([eventName, definitions]) =>
    definitions.flatMap((definition, groupIndex) =>
      (definition.hooks ?? []).flatMap((hook, handlerIndex) => {
        const entry = isCodexManagedCommand(hook.command)
          ? createCodexHookTrustEntry(
              hooksPath,
              eventName,
              groupIndex,
              handlerIndex,
              definition,
              hook
            )
          : null
        return entry ? [entry] : []
      })
    )
  )
}

/** How Codex will treat each Orca entry in the real ~/.codex/hooks.json. */
function realHomeOrcaEntryTrust(): string[] {
  const trust = readHookTrustEntries(join(homes.tmpHome, '.codex', 'config.toml'))
  return realHomeOrcaEntries().map((entry) => readOrcaEntryTrust(entry, trust))
}

async function resume(): Promise<Extract<CodexSessionResumePreparation, { outcome: 'resume' }>> {
  const prepared = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: 'abc' },
    target: { runtime: 'host' }
  })
  if (prepared?.outcome !== 'resume') {
    throw new Error('expected the session to resume')
  }
  return prepared
}

function launch(workspacePath: string): Promise<string | null> {
  return prepareCodexRuntimeHomeForLaunch(undefined, undefined, {
    launchAgent: 'codex',
    workspacePath
  })
}

beforeEach(() => {
  realHomeInternals.setLaneForTesting('pending')
  codexAppServerCapabilityCache.clear()
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
    grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
      if (request.invocation.envToDelete?.includes('CODEX_HOME')) {
        realHomeSessions += 1
        await hung
      }
      throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    })
    const workspaces = ['one', 'two'].map((name) => {
      const path = join(homes.tmpHome, name)
      mkdirSync(path, { recursive: true })
      return path
    })

    try {
      const first = launch(workspaces[0])
      expect(await settlesWithin(first, 2_000)).toBe(true)
      expect(await first).toBe(getOrcaManagedCodexHomePath())
      const second = launch(workspaces[1])
      expect(await settlesWithin(second, 2_000)).toBe(true)
      expect(await second).toBe(getOrcaManagedCodexHomePath())
      expect(realHomeSessions).toBe(1)

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
})

/** Codex approving every requested entry once `approval` resolves, as the grant session does. */
function installApprovingRunner(approval: Promise<void>): void {
  grantInternals.setGrantSessionRunner(async (request: CodexHookTrustGrantRequest) => {
    await approval
    const entries = request.expectedTrustKeys.map((key) => {
      const entry = { ...parseTrustKey(key)!, command: request.managedCommand, timeoutSec: 10 }
      return { key, entry, trustedHash: computeTrustedHash(entry) }
    })
    upsertHookTrustEntries(
      join(homes.tmpHome, '.codex', 'config.toml'),
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
}

describe('a Codex resume into the real ~/.codex while its approval runs', () => {
  it("spawns at once, trusting exactly Orca's entries for that one process", async () => {
    writeFileSync(
      join(homes.tmpHome, '.codex', 'hooks.json'),
      `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user.sh' }] }] } })}\n`
    )
    grantInternals.setGrantSessionRunner(() => new Promise(() => {}))

    const resumed = resume()
    expect(await settlesWithin(resumed, 2_000)).toBe(true)
    const trust = (await resumed).sessionHookTrust ?? []
    expect(realHomeOrcaEntryTrust().every((state) => state === 'untrusted')).toBe(true)
    const hooksPath = join(homes.tmpHome, '.codex', 'hooks.json')
    const orcaKeys = realHomeOrcaEntries().flatMap((entry) => [
      computeTrustKey(entry),
      computeTrustKey({ ...entry, sourcePath: getCodexExplicitHomeHookSourcePath(hooksPath) })
    ])
    expect(orcaKeys.length).toBeGreaterThan(0)
    expect(trust.map(({ key }) => key).sort()).toEqual([...new Set(orcaKeys)].sort())
    expect(trust.some(({ key }) => key.endsWith(':stop:0:0'))).toBe(false)
  })

  it("passes nothing extra once Codex has approved Orca's entries", async () => {
    installApprovingRunner(Promise.resolve())
    await resume()
    await realHomeInternals.settledLaneForTesting()
    expect(realHomeOrcaEntryTrust().every((state) => state === 'trusted')).toBe(true)

    expect((await resume()).sessionHookTrust).toBeUndefined()
  })

  it('passes nothing to a Codex known to lack hook trust', async () => {
    codexAppServerCapabilityCache.rememberUnsupported(getCodexAppServerHostKey({ kind: 'native' }))
    grantInternals.setGrantSessionRunner(() => new Promise(() => {}))

    expect((await resume()).sessionHookTrust).toBeUndefined()
  })
})

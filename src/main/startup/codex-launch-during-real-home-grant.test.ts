import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexHookTrustGrantRequest } from '../codex/codex-app-server-client'
import { setupCodexHookHomes } from '../codex/hook-service-test-harness'

// Why this file (QA case 4, full launch path): Codex's approval of the real-home
// entry runs in the background. A launch during it must settle on the managed
// home at once, with that home's hook install and the project trust write done.

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

function launch(workspacePath: string): Promise<string | null> {
  return prepareCodexRuntimeHomeForLaunch(undefined, undefined, {
    launchAgent: 'codex',
    workspacePath
  })
}

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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPtyHostEnv } from './assembly'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({
  userData: '',
  flags: null as { flag: string; codexVersion: string } | null
}))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData })
}))
vi.mock('../../../agent-hooks/server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: {
    ensureForDistro: vi.fn(),
    getGuestEndpointFilePath: () => '/guest/endpoint.json',
    getOpenCodeOverlayDir: () => null,
    getGuestAgentPath: () => null
  }
}))
vi.mock('../../../pi/titlebar-extension-service', () => ({
  piTitlebarExtensionService: { buildPtyEnv: () => ({}), buildFreshOmpEnv: () => ({}) }
}))
vi.mock('../../../cli/orca-cli-child-path', () => ({ prependOrcaCliDirToChildPath: () => {} }))
vi.mock('../../../cli/wsl-managed-cli', () => ({
  getManagedWslCliDir: () => undefined,
  getWslCliCommandName: () => 'orca-ide'
}))
vi.mock('../../../codex/codex-hook-session-trust', () => ({
  getCodexHookSessionFlags: () => fixture.flags
}))

let root: string
let options: BuildPtyHostEnvOptions
const FLAGS = { flag: 'hooks={}', codexVersion: 'codex-cli 1.2.3' }
// Why: a pane opened inside another Orca's pane inherits that Orca's values.
const INHERITED = {
  ORCA_CODEX_HOOK_CONFIG: 'hooks={stale}',
  ORCA_CODEX_HOOK_VERSION: 'codex-cli 0.0.1',
  ORCA_CODEX_HOOK_ARG: '"hooks={stale}"',
  ORCA_CODEX_HOOK_GATE: '"C:/stale/gate.cmd"'
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-hook-flag-env-'))
  fixture.userData = join(root, 'user-data')
  fixture.flags = FLAGS
  vi.stubEnv('HOME', join(root, 'home'))
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('Codex status hook flag in the pane env', () => {
  it('hands a native pane the flag and the version it was derived for', () => {
    const env = buildPtyHostEnv('pane-1', { ...INHERITED }, options)
    expect(env.ORCA_CODEX_HOOK_CONFIG).toBe('hooks={}')
    expect(env.ORCA_CODEX_HOOK_VERSION).toBe('codex-cli 1.2.3')
    // Why: the cmd macro reads it as unset at startup; only its gate sets it.
    expect(env.ORCA_CODEX_HOOK_ARG).toBeUndefined()
  })

  it.each([
    ['hooks are off', { agentStatusHooksEnabled: false }],
    ['Codex is disabled', { disabledTuiAgents: ['codex' as const] }],
    ['the pane is a WSL guest, whose Linux Codex keeps its installed hook', { isWsl: true }]
  ])('clears every inherited flag variable when %s', (_label, overrides) => {
    const env = buildPtyHostEnv('pane-1', { ...INHERITED }, { ...options, ...overrides })
    for (const key of Object.keys(INHERITED)) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('clears inherited flags while no flag is ready yet', () => {
    fixture.flags = null
    const env = buildPtyHostEnv('pane-1', { ...INHERITED }, options)
    for (const key of Object.keys(INHERITED)) {
      expect(env[key]).toBeUndefined()
    }
  })
})

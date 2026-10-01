import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'
import type { ClaudeProfileRoutingOwner } from './claude-profile-routing-owner'
import type { ClaudeProfileRoutingService } from './claude-profile-routing-service'
import {
  cleanupRuntimeAuthTestState,
  createClaudeAccount,
  createElectronMock,
  createKeychainMock,
  createOauthRefreshMock,
  createSettings,
  createStore,
  resetRuntimeAuthTestState,
  setPlatform,
  testState
} from './runtime-auth-service-test-harness'

// Real routing service, WSL owner and transport; only wsl.exe, the running probe, the runtime
// ensure and the bundle dir are faked.
const mocks = vi.hoisted(() => {
  const state: {
    root: string
    running: boolean
    runningChecks: number
    authority?: ClaudeProfileRoutingService
  } = { root: '', running: true, runningChecks: 0 }
  return {
    state,
    run: vi.fn<(spec: WslSpec) => Promise<WslResult>>(),
    runtime: vi.fn()
  }
})
vi.mock('electron', () => createElectronMock())
vi.mock('./oauth-refresh', () => createOauthRefreshMock())
vi.mock('./keychain', () => createKeychainMock())
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getAppPath: () => mocks.state.root,
    getPath: () => mocks.state.root
  })
}))
vi.mock('../wsl/wsl-relay-bundle-dirs', () => ({ wslRelayBundleDirs: () => [mocks.state.root] }))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: async (paths: string[]) => {
    mocks.state.runningChecks += 1
    return mocks.state.running ? paths : []
  }
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.run }))
vi.mock('../wsl/wsl-pinned-runtime', () => ({ ensureWslPinnedRuntime: mocks.runtime }))
vi.mock('./claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => mocks.state.authority,
  installClaudeProfileRoutingAuthority: () => {}
}))

const ubuntu = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
const rmCalls = () => mocks.run.mock.calls.filter(([spec]) => spec.script?.includes('rm -f'))
const helperActions = () =>
  mocks.run.mock.calls
    .filter(([spec]) => spec.program === '/usr/bin/env')
    .map(([spec]) => JSON.parse(spec.input ?? '{}').action)
const issue = (routing: ClaudeProfileRoutingService) =>
  routing.describeAccounts({ accounts: [], activeAccountId: null }).profileRoutingIssue

function hostOwner(root: string): ClaudeProfileRoutingOwner {
  const pointerPath = join(root, 'selected')
  writeFileSync(pointerPath, '')
  const descriptor = {
    profile: null,
    configHome: root,
    readHome: root,
    defaultHome: root,
    pointerPath,
    target: { runtime: 'host' as const }
  }
  return {
    resolve: () => descriptor,
    pointerPath: () => pointerPath,
    targets: () => [{ runtime: 'host' }],
    readHomes: () => [],
    capabilities: () => ['claude.profile-routing.v1'],
    isProvisioned: () => true,
    readiness: () => 'unsupported',
    prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }),
    publish: async () => {},
    withdraw: async () => {}
  }
}

async function routingFor(settings: () => GlobalSettings): Promise<ClaudeProfileRoutingService> {
  const { ClaudeProfileRoutingService } = await import('./claude-profile-routing-service')
  const { createWslClaudeProfileOwner, withWslClaudeProfileOwner } =
    await import('./claude-profile-wsl-owner')
  return new ClaudeProfileRoutingService(
    withWslClaudeProfileOwner(
      hostOwner(mocks.state.root),
      createWslClaudeProfileOwner(settings),
      settings
    )
  )
}

const ubuntuSettings = () =>
  createSettings({
    claudeManagedAccounts: [
      createClaudeAccount('u1', join(mocks.state.root, 'u1'), {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ],
    activeClaudeManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'u1' } }
  })

beforeEach(() => {
  resetRuntimeAuthTestState()
  mocks.state.root = mkdtempSync(join(tmpdir(), 'wsl-routing-flows-'))
  mocks.state.running = true
  mocks.state.runningChecks = 0
  mocks.state.authority = undefined
  mocks.run.mockReset().mockImplementation(async (spec) => ({
    code: 0,
    stdout:
      spec.program === '/usr/bin/env'
        ? JSON.stringify({
            ready: true,
            provisioned: true,
            homes: ['/home/fake/.claude'],
            historyHomes: { projects: [], transcripts: [] },
            report: { outcome: 'prepared', surfaces: {}, warnings: [] }
          })
        : '/mnt/c/fake-helper.cjs',
    stderr: '',
    timedOut: false,
    environmentResolved: true
  }))
  mocks.runtime.mockReset().mockImplementation(async (run) => {
    for (const program of ['uname', 'getconf', 'printf', 'probe']) {
      await run({ program, loginPath: 'none' })
    }
    return { executable: '/home/fake/node', home: '/home/fake' }
  })
  writeFileSync(join(mocks.state.root, 'claude-profile-wsl.cjs'), 'FAKE BUNDLE')
})
afterEach(() => {
  vi.useRealTimers()
  cleanupRuntimeAuthTestState()
  rmSync(mocks.state.root, { recursive: true, force: true })
})

describe('a WSL distro stopped when Orca starts', () => {
  it('republishes after the pane boots it, never withdrawing or latching an issue', async () => {
    vi.useFakeTimers()
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    mocks.state.running = false
    await expect(routing.startup()).rejects.toThrow('not running')
    expect(issue(routing)).toBeUndefined()
    const before = mocks.state.runningChecks
    routing.terminalEnv(ubuntu)
    // No probe before the pane's own wsl.exe has had a turn to boot the distro.
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.state.runningChecks).toBe(before)
    mocks.state.running = true
    await vi.advanceTimersByTimeAsync(1_000)
    expect(helperActions()).toEqual(['inspect', 'publish'])
    expect(rmCalls()).toHaveLength(0)
    expect(issue(routing)).toBeUndefined()
    expect(routing.terminalEnv(ubuntu)).toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('drops the repair silently while the distro stays stopped, and re-arms it', async () => {
    vi.useFakeTimers()
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    mocks.state.running = false
    routing.terminalEnv(ubuntu)
    routing.terminalEnv(ubuntu)
    await vi.advanceTimersByTimeAsync(7_000)
    expect(mocks.state.runningChecks).toBe(3)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(issue(routing)).toBeUndefined()
    routing.terminalEnv(ubuntu)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.state.runningChecks).toBe(4)
  })
})

describe('a WSL Claude launch in a distro with no publish yet', () => {
  it('prepares the guest once: the pane repair joins the launch', async () => {
    vi.useFakeTimers()
    const settings = ubuntuSettings()
    const routing = await routingFor(() => settings)
    routing.terminalEnv(ubuntu)
    await routing.prepare(ubuntu)
    await vi.advanceTimersByTimeAsync(7_000)
    // Before the join: 2 runtime ensures, 13 guest runs and 5 running checks for this launch.
    expect(mocks.runtime).toHaveBeenCalledTimes(1)
    expect(helperActions()).toEqual(['inspect', 'publish'])
    expect({
      wslRuns: mocks.run.mock.calls.length,
      runningChecks: mocks.state.runningChecks
    }).toEqual({ wslRuns: 7, runningChecks: 4 })
  })
})

describe('removing the last selected WSL account of a stopped distro', () => {
  async function removeLast(profileMode: boolean) {
    setPlatform('win32')
    const store = createStore(ubuntuSettings())
    if (profileMode) {
      mocks.state.authority = await routingFor(() => store.getSettings())
    }
    const retire = mocks.state.authority ? vi.spyOn(mocks.state.authority, 'retire') : undefined
    mocks.state.running = false
    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const { ClaudeAccountSelection } = await import('./claude-account-selection')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the getSettings/updateSettings pair these classes use.
    const runtimeAuth = new ClaudeRuntimeAuthService(store as never)
    const removeManagedAuth = vi.fn(async () => {})
    const selection = new ClaudeAccountSelection(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
      store as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: remove() calls only these two rate-limit members.
      {
        evictInactiveClaudeCache: vi.fn(),
        refreshForClaudeAccountChange: vi.fn(async () => {})
      } as never,
      runtimeAuth,
      removeManagedAuth
    )
    await selection.remove('u1')
    return { store, retire, removeManagedAuth }
  }

  it('succeeds with profiles, retiring the pointer best-effort without a guest publish', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await removeLast(true)
    expect(result.store.getSettings().claudeManagedAccounts).toEqual([])
    expect(result.retire).toHaveBeenCalledWith(ubuntu)
    expect(result.removeManagedAuth).toHaveBeenCalledTimes(1)
    expect(helperActions()).toEqual([])
    warn.mockRestore()
  })

  it('succeeds with the gate off exactly as before', async () => {
    const result = await removeLast(false)
    expect(result.store.getSettings().claudeManagedAccounts).toEqual([])
    expect(mocks.run).not.toHaveBeenCalled()
  })
})

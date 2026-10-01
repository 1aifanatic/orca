import type * as Keychain from '../claude-accounts/keychain'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ keychain: vi.fn(), usage: vi.fn(), keychainService: vi.fn() }))
vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: calls.keychainService
}))
vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: calls.keychain
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: calls.usage }))
vi.mock('../../shared/child-process/run-process', () => ({
  spawnProcess: () => {
    throw new Error('Usage must not launch a process')
  },
  runProcess: () => {
    throw new Error('Usage must not launch a process')
  }
}))
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { readClaudeOAuthCredentials } from './claude-oauth-credentials'
import { OAuthUsageError } from './claude-oauth-usage-error'
import { createNativeClaudeProfileRouting } from '../claude-accounts/claude-profile-native-owner'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function profile() {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-'))
  roots.push(home)
  calls.keychain.mockResolvedValue(null)
  const options = {
    authPreparation: {
      configDir: home,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      stripAuthEnv: true,
      provenance: 'profile:fake'
    }
  }
  return { home, options }
}
function systemDefault() {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-default-'))
  roots.push(home)
  calls.keychain.mockResolvedValue(null)
  return {
    home,
    options: {
      authPreparation: { configDir: home, envPatch: {}, stripAuthEnv: false, provenance: 'system' }
    }
  }
}
it('never refreshes an expired inactive token or launches a usage CLI', async () => {
  const f = profile()
  const file = join(f.home, '.credentials.json')
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: { accessToken: 'expired-fake', refreshToken: 'must-not-be-used', expiresAt: 1 }
    })
  )
  vi.stubGlobal('fetch', () => {
    throw new Error('No refresh endpoint')
  })
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    status: 'error',
    usageMetadata: { failureKind: 'stale-token' }
  })
  expect(calls.usage).not.toHaveBeenCalled()
})
it('reads only the requested scoped Keychain, with no unsuffixed fallback', async () => {
  const f = profile()
  await readClaudeOAuthCredentials({ credentialsFileConfigDir: f.home, keychainConfigDir: f.home })
  if (process.platform === 'darwin') {
    expect(calls.keychain.mock.calls).toEqual([[f.home]])
  } else {
    expect(calls.keychain).not.toHaveBeenCalled()
  }
})
it('distinguishes missing, malformed and inaccessible credential observations', async () => {
  const f = profile()
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    usageMetadata: { failureKind: 'missing-credentials' }
  })
  writeFileSync(join(f.home, '.credentials.json'), '{')
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    usageMetadata: { failureKind: 'keychain-unavailable' }
  })
})
it('refuses upgrade usage before any credential read and requests no hidden recovery on API rejection', async () => {
  const f = profile()
  expect(
    await fetchActiveClaudeRateLimits({
      authPreparation: {
        ...f.options.authPreparation,
        profileIssue: 'Sign in again to use this account.'
      }
    })
  ).toMatchObject({ status: 'error' })
  expect(calls.keychain).not.toHaveBeenCalled()
  writeFileSync(
    join(f.home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } })
  )
  calls.usage.mockRejectedValue(new Error('network unavailable'))
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({ status: 'error' })
  expect(calls.usage).toHaveBeenCalledTimes(1)
})

it('strict Keychain lookup never falls back to the unsuffixed service', async () => {
  const f = profile()
  calls.keychainService.mockResolvedValue(null)
  const actual = await vi.importActual<typeof Keychain>('../claude-accounts/keychain')
  await actual.readActiveClaudeKeychainCredentialsStrict(f.home)
  expect(calls.keychainService).toHaveBeenCalled()
  for (const [service] of calls.keychainService.mock.calls) {
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  }
  calls.keychainService.mockClear()
  calls.keychainService.mockRejectedValue(new Error('locked'))
  await expect(actual.readActiveClaudeKeychainCredentialsStrict(f.home)).rejects.toThrow('locked')
  expect(calls.keychainService).toHaveBeenCalledTimes(1)
})
it('treats an unreadable credential file as unavailable, not a missing login', async () => {
  const f = profile()
  mkdirSync(join(f.home, '.credentials.json'))
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    usageMetadata: { failureKind: 'keychain-unavailable' }
  })
})
it('hides Claude usage for System Default with no Claude login, instead of asking to sign in again', async () => {
  const f = systemDefault()
  expect(await fetchActiveClaudeRateLimits(f.options)).toMatchObject({
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials' }
  })
  expect(await fetchActiveClaudeRateLimits(profile().options)).toMatchObject({
    status: 'error',
    error: 'Sign in again to use this account.'
  })
})
it("keeps a 429's Retry-After and rate-limit message so polling waits it out", async () => {
  const f = profile()
  writeFileSync(
    join(f.home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } })
  )
  const message = 'Claude usage is rate limited right now.'
  calls.usage.mockRejectedValueOnce(new OAuthUsageError(message, 429, true, 3_000_000))
  const before = Date.now()
  const limited = await fetchActiveClaudeRateLimits(f.options)
  expect(limited).toMatchObject({
    status: 'error',
    error: message,
    usageMetadata: { failureKind: 'rate-limited' }
  })
  expect(limited.usageMetadata?.retryAtMs).toBeGreaterThanOrEqual(before + 3_000_000)
  expect(limited.usageMetadata?.retryAtMs).toBeLessThanOrEqual(Date.now() + 3_000_000)
  calls.usage.mockRejectedValueOnce(new OAuthUsageError(message, 429, true, null))
  expect((await fetchActiveClaudeRateLimits(f.options)).usageMetadata?.retryAtMs).toBeUndefined()
})
it("reads System Default's inherited CLAUDE_CONFIG_DIR Keychain item before the unsuffixed one", async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-usage-inherited-'))
  roots.push(root)
  const inherited = join(root, 'own-claude-config')
  const routing = createNativeClaudeProfileRouting({
    store: {
      getSettings: () => ({
        claudeManagedAccounts: [],
        activeClaudeManagedAccountId: null,
        agentStatusHooksEnabled: false,
        disabledTuiAgents: []
      })
    },
    dataRoot: join(root, 'data'),
    userHome: root,
    inheritedConfigDir: () => inherited,
    claudeVersion: async () => null,
    worker: { prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }) }
  })
  calls.keychain.mockResolvedValue(null)
  await fetchActiveClaudeRateLimits({
    authPreparation: routing.preparation(routing.resolve({ runtime: 'host' }))
  })
  expect(calls.keychain.mock.calls).toEqual(
    process.platform === 'darwin' ? [[inherited], [undefined]] : []
  )
  const managed = profile()
  calls.keychain.mockClear()
  await fetchActiveClaudeRateLimits(managed.options)
  expect(calls.keychain.mock.calls).toEqual(process.platform === 'darwin' ? [[managed.home]] : [])
})

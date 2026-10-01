import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { ClaudeAccountSelection } from './claude-account-selection'
import { ClaudeAccountRegistration } from './claude-account-registration'
import { createNativeClaudeProfileRouting } from './claude-profile-native-owner'
import { describeClaudeProfile, prepareClaudeProfileDirectory } from './claude-profile-paths'
import { installClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'

vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: () => {
    throw new Error('no keychain')
  }
}))

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(accounts: ClaudeManagedAccount[]) {
  const root = mkdtempSync(join(tmpdir(), 'r2a-'))
  roots.push(root)
  const home = join(root, 'personal')
  const dataRoot = join(root, 'data')
  mkdirSync(home)
  mkdirSync(dataRoot)
  const settings = {
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: null as string | null,
    activeClaudeManagedAccountIdsByRuntime: { host: null as string | null, wsl: {} },
    agentStatusHooksEnabled: false,
    disabledTuiAgents: [] as []
  }
  const routing = createNativeClaudeProfileRouting({
    store: { getSettings: () => settings },
    dataRoot,
    userHome: home,
    inheritedConfigDir: () => null,
    claudeVersion: async () => null,
    worker: { prepare: async () => ({ outcome: 'prepared', surfaces: {}, warnings: [] }) }
  })
  installClaudeProfileRoutingAuthority(routing)
  const store = {
    getSettings: () => settings,
    updateSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch)
  }
  const rateLimits = {
    evictInactiveClaudeCache: vi.fn(),
    refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
  }
  const selection = new ClaudeAccountSelection(store, rateLimits, {
    syncForCurrentSelection: async () => {},
    forceMaterializeCurrentSelectionForRollback: async () => {}
  })
  // The browser's Claude login decides which account Claude writes into the profile.
  let browserLogin = 'x@example.test'
  const profileHome = (id: string) => {
    const profile = describeClaudeProfile(dataRoot, id, {
      runtime: 'host',
      executionHostId: 'local'
    })
    prepareClaudeProfileDirectory(dataRoot, profile, home)
    return profile.home
  }
  const registration = new ClaudeAccountRegistration({
    store,
    rateLimits,
    runtimeAuth: { syncForCurrentSelection: async () => {} },
    selection,
    setCancel: () => {},
    prepare: async (id: string) => ({
      config: { windowsPath: profileHome(id), linuxPath: null, wslDistro: null },
      provision: async () => {}
    }),
    login: async (config) => {
      writeFileSync(
        join(config.windowsPath, '.claude.json'),
        JSON.stringify({ oauthAccount: { emailAddress: browserLogin, organizationUuid: 'org-1' } })
      )
    }
  })
  const rows = () =>
    selection
      .list()
      .accounts.map((entry) => [
        entry.id,
        entry.email,
        entry.profileReadiness,
        entry.profileIdentityIssue ?? null
      ])
      .sort(([l], [r]) => String(l).localeCompare(String(r)))
  return {
    settings,
    selection,
    registration,
    rows,
    signInAs: (email: string) => (browserLogin = email)
  }
}

const legacy = (id: string, email: string, lastAuthenticatedAt: number): ClaudeManagedAccount => ({
  id,
  email,
  organizationUuid: 'org-1',
  authMethod: 'subscription-oauth',
  managedAuthPath: '/old-layout',
  managedAuthRuntime: 'host',
  wslDistro: null,
  createdAt: lastAuthenticatedAt,
  updatedAt: lastAuthenticatedAt,
  lastAuthenticatedAt
})

it('keeps the original row when a re-sign-in lands on a login another row already owns', async () => {
  const f = fixture([legacy('a', 'a@example.test', 1), legacy('b', 'b@example.test', 2)])
  // The user clicks Sign in again on a@ while the browser is signed in to b@.
  f.signInAs('b@example.test')
  await expect(f.registration.reauthenticate('a')).rejects.toThrow(
    'Signed in as b@example.test, which is already added as another account. Sign in again as a@example.test, or remove this account.'
  )
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'ready', 'duplicate'],
    ['b', 'b@example.test', 'sign-in-required', null]
  ])
  // Signing the real b@ row in as b@ succeeds and leaves it the clean b@ row.
  await expect(f.registration.reauthenticate('b')).resolves.toHaveProperty('accounts')
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'ready', 'duplicate'],
    ['b', 'b@example.test', 'ready', null]
  ])
  await expect(f.selection.select('b')).resolves.toHaveProperty('accounts')
  // Signing a@ back in to its own login clears its flag.
  f.signInAs('a@example.test')
  await expect(f.registration.reauthenticate('a')).resolves.toHaveProperty('accounts')
  expect(f.rows()).toEqual([
    ['a', 'a@example.test', 'ready', null],
    ['b', 'b@example.test', 'ready', null]
  ])
})

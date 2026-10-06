import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
import { CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE } from './claude-account-registration'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import { ClaudeAccountService } from './service'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function account(id: string, extra: Partial<ClaudeManagedAccount> = {}): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.test`,
    managedAuthPath: '',
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  }
}

function fixture(accounts: ClaudeManagedAccount[] = [account('a'), account('b')]) {
  const root = mkdtempSync(join(tmpdir(), 'claude-accounts-'))
  roots.push(root)
  const home = (id: string) => join(root, id, 'home')
  // Stands in for Claude finishing `claude auth login` in a folder.
  const signIn = (id: string, email: string) => {
    mkdirSync(home(id), { recursive: true })
    writeFileSync(
      join(home(id), '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: email } })
    )
  }
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    claudeManagedAccounts: accounts,
    activeClaudeManagedAccountId: 'a',
    activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} }
  }
  const runtimeAuth = {
    router: { accountHome: home, userConfigDir: () => join(root, 'personal') },
    syncForCurrentSelection: vi.fn(async (_target?: ClaudeAccountSelectionTarget) => {}),
    publishAll: vi.fn(async () => {}),
    prepareAccountFolder: vi.fn(async (id: string) => {
      mkdirSync(home(id), { recursive: true })
      return { configDir: home(id), readPath: home(id) }
    }),
    removeAccountFolder: vi.fn(async (id: string) => rmSync(join(root, id), { recursive: true })),
    getRuntimeConfigDir: () => '/unused'
  }
  const service = new ClaudeAccountService(
    {
      getSettings: () => settings,
      updateSettings: (patch) => {
        settings = { ...settings, ...patch }
      }
    },
    {
      evictInactiveClaudeCache: vi.fn(),
      refreshForClaudeAccountChange: vi.fn().mockResolvedValue(undefined)
    },
    runtimeAuth
  )
  return { root, service, runtimeAuth, signIn, settings: () => settings }
}

describe('ClaudeAccountService', () => {
  it("labels each row with its folder's login and asks a folder without one to sign in", () => {
    const f = fixture([
      account('a'),
      account('b'),
      account('old-wsl', {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: '/home/u/.local/share/orca/claude-accounts/old-wsl/auth'
      }),
      account('new-wsl', {
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        wslLinuxAuthPath: '/home/u/.local/share/orca/claude-profiles/new-wsl/home'
      })
    ])
    f.signIn('a', 'now-a@example.test')
    const byId = new Map(f.service.listAccounts().accounts.map((row) => [row.id, row]))
    expect(byId.get('a')).toMatchObject({ email: 'now-a@example.test' })
    expect(byId.get('a')?.needsSignIn).toBeUndefined()
    expect(byId.get('b')).toMatchObject({ email: 'b@example.test', needsSignIn: true })
    expect(byId.get('old-wsl')).toMatchObject({ needsSignIn: true })
    expect(byId.get('new-wsl')?.needsSignIn).toBeUndefined()
  })

  it("reports System default's login and the user's own folder while an account is selected", () => {
    const f = fixture()
    mkdirSync(join(f.root, 'personal'))
    writeFileSync(
      join(f.root, 'personal', '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.test' } })
    )
    expect(f.service.listAccounts()).toMatchObject({
      systemDefaultEmail: 'me@example.test',
      userClaudeConfigDir: join(f.root, 'personal')
    })
  })

  it('saves an account only once its folder holds a login', async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ runtime: 'host' })
    expect(begun).toMatchObject({
      runtime: 'host',
      configDir: join(f.root, begun.accountId, 'home')
    })
    await expect(f.service.finishSignIn(begun)).rejects.toThrow(CLAUDE_SIGN_IN_NOT_FINISHED_MESSAGE)
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)

    f.signIn(begun.accountId, 'new@example.test')
    await f.service.finishSignIn(begun)
    expect(f.settings().claudeManagedAccounts.at(-1)).toMatchObject({
      id: begun.accountId,
      email: 'new@example.test',
      managedAuthPath: begun.configDir
    })
  })

  it('refuses a second account for the same login and deletes its folder', async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ runtime: 'host' })
    f.signIn(begun.accountId, 'B@example.test')
    await expect(f.service.finishSignIn(begun)).rejects.toThrow('already added')
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledWith(begun.accountId, {
      runtime: 'host'
    })
    expect(f.settings().claudeManagedAccounts).toHaveLength(2)
  })

  it('relabels a saved account signed in again under another login', async () => {
    const f = fixture()
    const begun = await f.service.beginSignIn({ accountId: 'b' })
    f.signIn('b', 'other@example.test')
    await f.service.finishSignIn(begun)
    expect(f.settings().claudeManagedAccounts.find((entry) => entry.id === 'b')).toMatchObject({
      email: 'other@example.test',
      createdAt: 1
    })
  })

  it('clears the selection, republishes, then deletes the folder on remove', async () => {
    const f = fixture()
    f.signIn('a', 'a@example.test')
    await f.service.removeAccount('a')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBeNull()
    expect(f.runtimeAuth.syncForCurrentSelection).toHaveBeenCalledWith({ runtime: 'host' })
    expect(f.runtimeAuth.removeAccountFolder).toHaveBeenCalledWith('a', { runtime: 'host' })
  })

  it('puts the previous account back when publishing a new selection fails', async () => {
    const f = fixture()
    f.runtimeAuth.syncForCurrentSelection.mockRejectedValueOnce(new Error('publish failed'))
    await expect(f.service.selectAccount('b')).rejects.toThrow('publish failed')
    expect(f.settings().activeClaudeManagedAccountIdsByRuntime?.host).toBe('a')
    expect(f.runtimeAuth.publishAll).toHaveBeenCalled()
  })

  it('refuses to select a WSL account for the host', async () => {
    const f = fixture([
      account('a'),
      account('w', { managedAuthRuntime: 'wsl', wslDistro: 'Ubuntu' })
    ])
    await expect(f.service.selectAccountForTarget('w', { runtime: 'host' })).rejects.toThrow(
      'That Claude account belongs to a different runtime.'
    )
  })
})

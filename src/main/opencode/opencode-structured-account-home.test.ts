import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { ManagedDataAccountsState } from '../../shared/managed-account-types'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import {
  environmentForStructuredOpenCodeAccountHome,
  resolveStructuredOpenCodeAccountHome
} from './opencode-structured-account-home'

const first = '123e4567-e89b-42d3-a456-426614174000'
const second = '123e4567-e89b-42d3-a456-426614174001'

function managedAccounts() {
  let activeAccountId: string | null = first
  let available = new Set([first, second])
  return {
    list: (): ManagedDataAccountsState => ({
      accounts: [...available].map((id) => ({ id, label: id, integrations: [], createdAt: 0 })),
      activeAccountId
    }),
    restoreOriginalEnvironment: (environment: Record<string, string | undefined>) =>
      restoreManagedDataAccountEnvironment(environment),
    environmentForAccount: (_provider: 'opencode' | 'devin', id: string) => {
      if (!available.has(id)) {
        throw new Error('Managed account not found.')
      }
      return {
        XDG_DATA_HOME: `/profiles/${id}/data`,
        XDG_STATE_HOME: `/profiles/${id}/state`,
        OPENCODE_DB: 'opencode.db',
        OPENCODE_AUTH_CONTENT: ''
      }
    },
    select: (id: string | null) => {
      activeAccountId = id
    },
    remove: (id: string) => {
      available = new Set([...available].filter((entry) => entry !== id))
    }
  }
}

describe('structured OpenCode account binding', () => {
  it('derives default data and state from the effective child home', () => {
    const accounts = managedAccounts()
    accounts.select(null)
    const childHome = process.platform === 'win32' ? 'C:\\alternate' : '/alternate'
    const binding = resolveStructuredOpenCodeAccountHome({
      launchEnv: { [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: childHome },
      managedAccounts: accounts
    })
    expect(binding.locator).toEqual({
      kind: 'unmanaged',
      dataHome: join(childHome, '.local', 'share'),
      stateHome: join(childHome, '.local', 'state'),
      databaseSelection: { kind: 'default' }
    })
  })
  it('uses the pinned managed profile after selection changes and refuses removal', () => {
    const accounts = managedAccounts()
    const binding = resolveStructuredOpenCodeAccountHome({
      launchEnv: {},
      managedAccounts: accounts
    })
    accounts.select(second)
    const environment = environmentForStructuredOpenCodeAccountHome(binding, {
      managedAccounts: accounts,
      baseEnvironment: { PATH: '/bin' }
    })
    expect(environment.XDG_DATA_HOME).toBe(`/profiles/${first}/data`)
    expect(environment.OPENCODE_DB).toBe('opencode.db')
    expect(
      resolveStructuredOpenCodeAccountHome({ launchEnv: {}, managedAccounts: accounts }).locator
    ).toEqual({ kind: 'managed', managedProfileId: second })
    accounts.remove(first)
    expect(() =>
      environmentForStructuredOpenCodeAccountHome(binding, {
        managedAccounts: accounts,
        baseEnvironment: {}
      })
    ).toThrow('Managed account not found.')
  })

  it('captures independent unmanaged homes and an explicit database selection', () => {
    const accounts = managedAccounts()
    accounts.select(null)
    const binding = resolveStructuredOpenCodeAccountHome({
      launchEnv: { XDG_DATA_HOME: '/data', XDG_STATE_HOME: '/state', OPENCODE_DB: 'custom.db' },
      managedAccounts: accounts,
      homeDirectory: '/home/user'
    })
    expect(binding.locator).toEqual({
      kind: 'unmanaged',
      dataHome: '/data',
      stateHome: '/state',
      databaseSelection: { kind: 'override', value: 'custom.db' }
    })
    const environment = environmentForStructuredOpenCodeAccountHome(binding, {
      managedAccounts: accounts,
      baseEnvironment: {
        XDG_DATA_HOME: '/later',
        XDG_STATE_HOME: '/later',
        OPENCODE_DB: 'other.db'
      }
    })
    expect(environment).toEqual({
      XDG_DATA_HOME: '/data',
      XDG_STATE_HOME: '/state',
      OPENCODE_DB: 'custom.db'
    })
  })

  it('resolves host defaults and removes stale inherited managed overlays', () => {
    const accounts = managedAccounts()
    accounts.select(null)
    const binding = resolveStructuredOpenCodeAccountHome({
      launchEnv: {},
      managedAccounts: accounts,
      homeDirectory: '/host'
    })
    expect(binding.locator).toEqual({
      kind: 'unmanaged',
      dataHome: join('/host', '.local', 'share'),
      stateHome: join('/host', '.local', 'state'),
      databaseSelection: { kind: 'default' }
    })
    const environment = environmentForStructuredOpenCodeAccountHome(binding, {
      managedAccounts: accounts,
      baseEnvironment: {
        ORCA_DATA_ACCOUNT_PROVIDER: 'opencode',
        ORCA_DATA_ACCOUNT_DATA_HOME: '/old/data',
        ORCA_DATA_ACCOUNT_STATE_HOME: '/old/state',
        XDG_DATA_HOME: '/old/data',
        XDG_STATE_HOME: '/old/state',
        OPENCODE_DB: 'opencode.db',
        OPENCODE_AUTH_CONTENT: '',
        PATH: '/bin'
      }
    })
    expect(environment).toEqual({
      XDG_DATA_HOME: join('/host', '.local', 'share'),
      XDG_STATE_HOME: join('/host', '.local', 'state'),
      PATH: '/bin'
    })
  })

  it('restores the inherited account overlay before configured launch overrides', () => {
    const accounts = managedAccounts()
    accounts.select(null)
    const binding = resolveStructuredOpenCodeAccountHome({
      managedAccounts: accounts,
      homeDirectory: '/host',
      baseEnvironment: {
        ORCA_DATA_ACCOUNT_PROVIDER: 'opencode',
        ORCA_DATA_ACCOUNT_DATA_HOME: '/old/data',
        ORCA_DATA_ACCOUNT_STATE_HOME: '/old/state',
        ORCA_DATA_ACCOUNT_ORIGINAL_ENV: JSON.stringify({
          XDG_DATA_HOME: '/original/data',
          XDG_STATE_HOME: null,
          OPENCODE_DB: 'original.db',
          OPENCODE_AUTH_CONTENT: null
        }),
        XDG_DATA_HOME: '/old/data',
        XDG_STATE_HOME: '/old/state',
        OPENCODE_DB: 'opencode.db',
        OPENCODE_AUTH_CONTENT: ''
      },
      launchEnv: { XDG_DATA_HOME: '/configured/data' }
    })
    expect(binding.locator).toEqual({
      kind: 'unmanaged',
      dataHome: '/configured/data',
      stateHome: join('/host', '.local', 'state'),
      databaseSelection: { kind: 'override', value: 'original.db' }
    })
  })

  it('refuses unmanaged inline authentication that cannot survive a restart', () => {
    const accounts = managedAccounts()
    accounts.select(null)
    expect(() =>
      resolveStructuredOpenCodeAccountHome({
        launchEnv: { OPENCODE_AUTH_CONTENT: 'inline-secret' },
        managedAccounts: accounts
      })
    ).toThrow('structured_agent_session_unsupported')
  })
})

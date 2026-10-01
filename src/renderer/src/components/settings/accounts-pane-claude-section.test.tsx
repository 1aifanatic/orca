import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import { i18n } from '../../i18n/i18n'
import { useAppStore } from '../../store'
import {
  renderClaudeAccountsSection,
  type ClaudeAccountsSectionModel
} from './accounts-pane-claude-section'

function account(
  id: string,
  email: string,
  overrides: Partial<ClaudeManagedAccountSummary> = {}
): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    profileReadiness: 'ready',
    ...overrides
  }
}

function render(state: Partial<ClaudeRateLimitAccountsState> = {}): string {
  const claudeAccounts: ClaudeRateLimitAccountsState = {
    accounts: [],
    activeAccountId: null,
    ...state
  }
  const model: ClaudeAccountsSectionModel = {
    accountRuntime: { runtime: 'host', wslDistro: null, label: 'This device' },
    accountRuntimeSentenceLabel: 'this device',
    accountRuntimeUnavailable: false,
    accountVisibilityOptions: { remoteOwner: false, ownerPlatform: 'darwin' },
    claudeAccounts,
    claudeAction: 'idle',
    isRemoteAccountScope: false,
    remoteAccountScopeNotice: null,
    runClaudeAccountAction: vi.fn(async () => {}),
    setRemoveClaudeTarget: vi.fn(),
    settings: getDefaultSettings('/tmp'),
    systemClaudeActive: claudeAccounts.activeAccountId === null,
    visibleClaudeAccounts: claudeAccounts.accounts,
    wslCapabilitiesLoading: false
  }
  return renderToStaticMarkup(React.createElement(() => renderClaudeAccountsSection(model)))
}

function buttonsLabelled(markup: string, label: string): string[] {
  return [...markup.matchAll(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/g)]
    .map(([button]) => button)
    .filter((button) => button.includes(`${label}</button>`))
}

describe('Claude accounts section', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
  })

  it('lets every row be removed, whatever its readiness', () => {
    const markup = render({
      accounts: [
        account('draft', '', { profileReadiness: 'sign-in-required' }),
        account('legacy', 'old@example.test', { profileReadiness: 'sign-in-required' }),
        account('gone', 'gone@example.test', { profileReadiness: 'unavailable' }),
        account('ready', 'ok@example.test')
      ]
    })
    const removes = buttonsLabelled(markup, 'Remove')
    expect(removes).toHaveLength(4)
    expect(removes.filter((button) => button.includes('disabled=""'))).toEqual([])
  })

  it('names the login each profile holds and blocks selecting a row holding another login', () => {
    const markup = render({
      accounts: [
        account('mismatch', 'a@example.test', {
          profileEmail: 'b@example.test',
          profileIdentityIssue: 'mismatch'
        }),
        account('duplicate', 'c@example.test', {
          profileEmail: 'c@example.test',
          profileIdentityIssue: 'duplicate'
        }),
        account('ready', 'ok@example.test', { profileEmail: 'ok@example.test' })
      ]
    })
    expect(markup).toContain(
      'This account was added as a@example.test but is now signed in as b@example.test.'
    )
    expect(markup).toContain('c@example.test is already added as another account.')
    const selects = [
      ...markup.matchAll(/<button type="button"[^>]*class="flex min-w-0 flex-1[^"]*"[^>]*>/g)
    ]
    expect(selects.map(([button]) => button.includes('disabled=""'))).toEqual([true, true, false])
  })

  it("names System Default's login and says when an earlier Orca left a saved account there", () => {
    const markup = render({
      systemDefault: { email: 'a@example.test', leftByEarlierOrca: true }
    })
    expect(markup).toContain('System default: a@example.test')
    expect(markup).toContain(
      'An earlier Orca version left a@example.test signed in to your personal Claude login. Select System default and run `claude /login` to sign back in to your own account.'
    )
    const own = render({ systemDefault: { email: 'me@example.test', leftByEarlierOrca: false } })
    expect(own).toContain('System default: me@example.test')
    expect(own).not.toContain('An earlier Orca version')
  })

  it('explains the one-time sign-in only while a saved account still needs it', () => {
    expect(render()).not.toContain('After upgrading')
    const markup = render({
      accounts: [account('legacy', 'old@example.test', { profileReadiness: 'sign-in-required' })]
    })
    expect(markup).toContain(
      'After upgrading, sign in once for each saved account. Usage may be stale or expired until you start Claude in that account.'
    )
    expect(markup).not.toContain('stays separate')
  })
})

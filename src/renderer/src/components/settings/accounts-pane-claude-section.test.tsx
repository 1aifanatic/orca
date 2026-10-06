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
    setClaudeSignIn: vi.fn(),
    setRemoveClaudeTarget: vi.fn(),
    settings: getDefaultSettings('/tmp'),
    systemClaudeActive: claudeAccounts.activeAccountId === null,
    visibleClaudeAccounts: claudeAccounts.accounts,
    wslCapabilitiesLoading: false
  }
  return renderToStaticMarkup(React.createElement(() => renderClaudeAccountsSection(model)))
}

function selectButtons(markup: string): string[] {
  return [
    ...markup.matchAll(/<button type="button"[^>]*class="flex min-w-0 flex-1[^"]*"[^>]*>/g)
  ].map(([button]) => button)
}

describe('Claude accounts section', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    useAppStore.setState({ settingsSearchQuery: '', runtimeEnvironments: [] })
  })

  it('asks a folder with no login to sign in again, and keeps it unselectable but removable', () => {
    const markup = render({
      accounts: [
        account('legacy', 'old@example.test', { needsSignIn: true }),
        account('ready', 'ok@example.test')
      ]
    })
    expect(markup).toContain('Sign in again to use this account')
    expect(selectButtons(markup).map((button) => button.includes('disabled=""'))).toEqual([
      true,
      false
    ])
    expect(markup.match(/>Remove<\/button>/g)).toHaveLength(2)
  })

  it("names System default's login and says when it is also a saved account", () => {
    const saved = render({
      accounts: [account('a', 'A@example.test')],
      systemDefaultEmail: 'a@example.test'
    })
    expect(saved).toContain('System default: a@example.test')
    expect(saved).toContain('An earlier Orca version may have copied that login there.')
    const own = render({ systemDefaultEmail: 'me@example.test' })
    expect(own).toContain('System default: me@example.test')
    expect(own).not.toContain('An earlier Orca version')
  })

  it("says when the user's own CLAUDE_CONFIG_DIR wins in their terminals", () => {
    expect(render()).not.toContain('CLAUDE_CONFIG_DIR')
    expect(render({ userClaudeConfigDir: '/home/me/.claude-work' })).toContain(
      'Your shell sets CLAUDE_CONFIG_DIR to /home/me/.claude-work'
    )
  })

  it('says what terminals from before the update do', () => {
    expect(render()).not.toContain('before this Orca update')
    expect(render({ olderTerminalsRunning: true })).toContain(
      'Terminals opened before this Orca update don&#x27;t follow the selected account'
    )
  })
})

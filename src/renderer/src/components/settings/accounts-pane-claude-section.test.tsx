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
})

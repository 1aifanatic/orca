import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { i18n } from '../../i18n/i18n'

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { createClaudeAccountActionRunner } from './accounts-pane-account-actions'

const added: ClaudeRateLimitAccountsState = {
  accounts: [
    {
      id: 'new',
      email: 'new@example.test',
      managedAuthRuntime: 'host',
      wslDistro: null,
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  ],
  activeAccountId: null
}

describe('Claude account action toasts', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    toast.info.mockClear()
  })

  it('says an added account is not selected yet instead of "System default → System default"', async () => {
    const run = createClaudeAccountActionRunner({
      settings: getDefaultSettings('/tmp'),
      accountRuntime: { runtime: 'host', wslDistro: null, label: 'This device' },
      isRemoteAccountScope: true,
      claudeAccounts: { accounts: [], activeAccountId: null },
      setClaudeAccounts: vi.fn(),
      setClaudeAction: vi.fn(),
      fetchSettings: vi.fn(async () => {}),
      recordFeatureInteraction: vi.fn()
    })
    await run('adding', async () => added)
    expect(toast.info).toHaveBeenCalledWith(expect.any(String), {
      description: 'Account added. Select it to use it for the next Claude you start.'
    })
  })
})

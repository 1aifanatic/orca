import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getClaudeProfileRoutingAuthority } from '../claude-accounts/claude-profile-routing-authority'
import type { InactiveClaudeAccount } from './claude-managed-account-credentials'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { makeClaudeUsageResult } from './claude-usage-result'

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  let home: string
  try {
    const authority = getClaudeProfileRoutingAuthority()
    if (!authority) {
      throw new Error('Claude profile host is unavailable.')
    }
    home = authority.accountHome(account.id)
  } catch {
    return makeClaudeUsageResult(
      'error',
      'Sign in again to use this account, or retry when its host is available.',
      { failureKind: 'missing-credentials', attemptedSources: [] }
    )
  }
  return fetchActiveClaudeRateLimits({
    signal: options.signal,
    authPreparation: {
      configDir: home,
      runtime: account.managedAuthRuntime,
      wslDistro: account.wslDistro,
      wslLinuxConfigDir: account.wslLinuxAuthPath,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      stripAuthEnv: true,
      provenance: `profile:${account.id}`
    }
  })
}

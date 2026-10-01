import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

export type ClaudeRateLimitFetchOptions = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  /** Let the account's own Claude CLI refresh an expired login; off unless the caller opts in. */
  allowCliLoginRefresh?: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

export type ClaudeManagedAccountUsageOptions = {
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

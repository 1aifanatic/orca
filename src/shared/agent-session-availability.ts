export type AgentSessionAccountKind = 'managed' | 'system'

export type AgentSessionUnavailable =
  | { reason: 'notSignedIn'; account?: AgentSessionAccountKind }
  | { reason: 'cliMissing' }

export type AgentSessionUnavailableObservation = AgentSessionUnavailable & { expiresInMs: number }

export const AGENT_SESSION_AVAILABILITY_TTL_MS = 30_000

export function readAgentSessionUnavailable(
  value: unknown
): AgentSessionUnavailableObservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  if (
    !('expiresInMs' in value) ||
    typeof value.expiresInMs !== 'number' ||
    !Number.isFinite(value.expiresInMs) ||
    value.expiresInMs <= 0 ||
    value.expiresInMs > AGENT_SESSION_AVAILABILITY_TTL_MS ||
    !('reason' in value)
  ) {
    return null
  }
  if (value.reason === 'cliMissing') {
    return { reason: 'cliMissing', expiresInMs: value.expiresInMs }
  }
  if (value.reason !== 'notSignedIn') {
    return null
  }
  const account = 'account' in value ? value.account : undefined
  if ('account' in value && account !== 'managed' && account !== 'system') {
    return null
  }
  return {
    reason: 'notSignedIn',
    expiresInMs: value.expiresInMs,
    ...(account === 'managed' || account === 'system' ? { account } : {})
  }
}

export function agentSessionSignInCopyId(
  provider: 'claude' | 'codex',
  account?: AgentSessionAccountKind
) {
  return provider === 'claude'
    ? account === 'managed'
      ? 'claudeManagedNotSignedIn'
      : 'claudeSystemNotSignedIn'
    : account === 'managed'
      ? 'codexManagedNotSignedIn'
      : 'codexSystemNotSignedIn'
}

export function claudeInitializationSignedOut(initialization: unknown): boolean {
  if (
    typeof initialization !== 'object' ||
    initialization === null ||
    !('account' in initialization)
  ) {
    return false
  }
  const account = initialization.account
  return (
    typeof account === 'object' &&
    account !== null &&
    'tokenSource' in account &&
    account.tokenSource === 'none'
  )
}

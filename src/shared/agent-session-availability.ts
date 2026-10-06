export type AgentSessionAccountKind = 'managed' | 'system'

export type AgentSessionUnavailable =
  | { reason: 'notSignedIn'; account?: AgentSessionAccountKind }
  | { reason: 'cliMissing' }

export type AgentSessionUnavailableObservation = AgentSessionUnavailable & { expiresInMs: number }

export type AgentSessionModelCatalogObservation = {
  unavailable?: AgentSessionUnavailableObservation
  /** A waiting catalog read joins the host's current listing. Optional for older hosts. */
  listingInProgress?: true
}

/** The longest this client holds a host's verdict before reading again; a longer host lifetime
 *  is clamped to it, never treated as unknown. */
export const AGENT_SESSION_AVAILABILITY_MAX_HOLD_MS = 30_000

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
    !('reason' in value)
  ) {
    return null
  }
  const expiresInMs = Math.min(value.expiresInMs, AGENT_SESSION_AVAILABILITY_MAX_HOLD_MS)
  if (value.reason === 'cliMissing') {
    return { reason: 'cliMissing', expiresInMs }
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
    expiresInMs,
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
  if (typeof account !== 'object' || account === null) {
    return false
  }
  // An API key (ANTHROPIC_API_KEY or a Console /login key) reports tokenSource "none".
  const apiKeySource = 'apiKeySource' in account ? account.apiKeySource : undefined
  return (
    'tokenSource' in account &&
    account.tokenSource === 'none' &&
    (typeof apiKeySource !== 'string' || apiKeySource === '' || apiKeySource === 'none')
  )
}

export type AgentSessionAccountKind = 'managed' | 'system'

export type AgentSessionUnavailable =
  | { reason: 'notSignedIn'; account?: AgentSessionAccountKind }
  | { reason: 'cliMissing' }

/** Whether a new child can start under the account home a chat runs with. */
export type AgentSessionAvailabilityState =
  | { state: 'ready' }
  | { state: 'notSignedIn'; account?: AgentSessionAccountKind }
  | { state: 'cliMissing' }

/** The host's answer on the catalog reply. A blocked answer says when to read again; absent (an
 *  older host, or no check yet) is unknown, which never blocks. */
export type AgentSessionAvailability =
  | { state: 'ready' }
  | { state: 'notSignedIn'; account?: AgentSessionAccountKind; recheckInMs: number }
  | { state: 'cliMissing'; recheckInMs: number }

export type AgentSessionModelCatalogObservation = {
  availability?: AgentSessionAvailability
  /** A waiting catalog read joins the host's current listing. Optional for older hosts. */
  listingInProgress?: true
}

export function agentSessionAvailabilityState(
  unavailable: AgentSessionUnavailable
): AgentSessionAvailabilityState {
  return unavailable.reason === 'notSignedIn'
    ? { state: 'notSignedIn', ...(unavailable.account ? { account: unavailable.account } : {}) }
    : { state: 'cliMissing' }
}

/** The longest this client holds a blocked answer before reading again; a longer host hint is
 *  clamped to it, never treated as unknown. */
export const AGENT_SESSION_AVAILABILITY_MAX_HOLD_MS = 30_000

export function readAgentSessionAvailability(value: unknown): AgentSessionAvailability | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !('state' in value)) {
    return null
  }
  if (value.state === 'ready') {
    return { state: 'ready' }
  }
  if (
    !('recheckInMs' in value) ||
    typeof value.recheckInMs !== 'number' ||
    !Number.isFinite(value.recheckInMs) ||
    value.recheckInMs <= 0
  ) {
    return null
  }
  const recheckInMs = Math.min(value.recheckInMs, AGENT_SESSION_AVAILABILITY_MAX_HOLD_MS)
  if (value.state === 'cliMissing') {
    return { state: 'cliMissing', recheckInMs }
  }
  if (value.state !== 'notSignedIn') {
    return null
  }
  const account = 'account' in value ? value.account : undefined
  if ('account' in value && account !== 'managed' && account !== 'system') {
    return null
  }
  return {
    state: 'notSignedIn',
    recheckInMs,
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

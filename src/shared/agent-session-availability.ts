export type AgentSessionAccountKind = 'managed' | 'system'

/** Why no chat can start under the account a chat runs with, as the host's catalog probe found it.
 *  Absent (an older host, or no verdict yet) is unknown, which never blocks. */
export type AgentSessionUnavailable =
  | { reason: 'notSignedIn'; account?: AgentSessionAccountKind }
  | { reason: 'cliMissing' }

/** A reason this build does not know reads as unknown, never as a different reason. */
export function readAgentSessionUnavailable(value: unknown): AgentSessionUnavailable | null {
  if (typeof value !== 'object' || value === null || !('reason' in value)) {
    return null
  }
  if (value.reason === 'cliMissing') {
    return { reason: 'cliMissing' }
  }
  if (value.reason !== 'notSignedIn') {
    return null
  }
  const account = 'account' in value ? value.account : undefined
  return {
    reason: 'notSignedIn',
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

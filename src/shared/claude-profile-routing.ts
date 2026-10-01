/** Step 4 enables this only after the credential writers have been removed. */
export function claudeProfileRoutingEnabled(): boolean {
  return false
}

export const CLAUDE_PROFILE_ROUTING_CAPABILITY = 'claude.profile-routing.v1'
export const CLAUDE_PROFILE_POINTER_ENV = 'ORCA_CLAUDE_PROFILE_POINTER'

export function requireClaudeProfileRoutingCapability(capabilities: readonly string[]): void {
  if (!capabilities.includes(CLAUDE_PROFILE_ROUTING_CAPABILITY)) {
    throw new Error('This host does not support Claude profiles. Update the execution host.')
  }
}

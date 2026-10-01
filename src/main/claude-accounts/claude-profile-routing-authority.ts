import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import type { ClaudeProfileRoutingService } from './claude-profile-routing-service'

let authority: ClaudeProfileRoutingService | undefined
/** Installed by the execution host; no settings/env/UI switch enables this dormant rollout. */
export function installClaudeProfileRoutingAuthority(value: ClaudeProfileRoutingService): void {
  authority = value
}
export function getClaudeProfileRoutingAuthority(): ClaudeProfileRoutingService | undefined {
  if (!claudeProfileRoutingEnabled()) {
    return undefined
  }
  if (!authority) {
    throw new Error('Claude account routing is unavailable on this host')
  }
  return authority
}

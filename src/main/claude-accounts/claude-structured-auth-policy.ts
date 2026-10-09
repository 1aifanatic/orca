import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { getClaudeProfileRouter } from './claude-profile-installed-router'
import { isHostManagedClaudeAccount } from './environment'
import { getSelectedClaudeAccountIdForTarget } from './runtime-selection'

/** The structured mirror of the terminal preflight's `prepareClaudeAuth` result:
 *  the one field a launch resolution needs from the managed-account state. */
export type ClaudeStructuredAuthPolicy = {
  stripAuthEnv: boolean
  /** Which login a failed sign-in names; absent, it follows `stripAuthEnv`. */
  account?: AgentSessionAccountKind
}

/**
 * The only supported way to build a structured launch's auth policy.
 *
 * It exists as a named function rather than an inline object at the wiring site so
 * that the settings-to-policy mapping is testable on its own: the one production
 * wiring lives in a `@ts-nocheck` file, where neither the compiler nor a type test
 * can see a dropped field.
 *
 * Structured Claude always spawns a native local-host child — the launch resolver
 * refuses any record with a remote execution host or a WSL distro — so the host
 * selection, not the platform default target, owns its auth.
 */
export function claudeStructuredAuthPolicyForSettings(
  settings: Pick<
    GlobalSettings,
    | 'claudeManagedAccounts'
    | 'activeClaudeManagedAccountId'
    | 'activeClaudeManagedAccountIdsByRuntime'
  >
): ClaudeStructuredAuthPolicy {
  // Why the router first: it decides whether the account or System default runs, as for terminals.
  const router = getClaudeProfileRouter()
  const managed = router
    ? router.routesToAccount()
    : isHostManagedClaudeAccount(
        settings.claudeManagedAccounts,
        getSelectedClaudeAccountIdForTarget(settings, { runtime: 'host' })
      )
  // Why never strip: a shell proxy's key must travel with its ANTHROPIC_BASE_URL, on every account.
  return { stripAuthEnv: false, account: managed ? 'managed' : 'system' }
}

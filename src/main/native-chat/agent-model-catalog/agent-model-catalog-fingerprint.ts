import { createHash } from 'node:crypto'
import type { StructuredAgentCommandInvocation } from '../../../shared/tui-agent-launch-command-override'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentModelCatalogSessionAccess,
  AgentModelCatalogStore
} from './agent-model-catalog-store'

/**
 * Everything that changes which models a listing can answer with: the agent,
 * the account home the CLI reads credentials/config from, its command and leading arguments, and the execution
 * host that runs the binary. Login-state or CLI-version drift under the same
 * key is corrected by the next refresh, never by the fingerprint.
 */
export type AgentModelCatalogIdentity = {
  agent: 'claude' | 'codex'
  accountHomeVariable: string
  accountHomePath: string
  /** Null on the native host; WSL distros each carry their own CLI. */
  wslDistro: string | null
  invocation?: StructuredAgentCommandInvocation
}

export function agentModelCatalogFingerprint(identity: AgentModelCatalogIdentity): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.agent,
        identity.accountHomeVariable,
        identity.accountHomePath,
        identity.wslDistro ?? '',
        ...(identity.invocation
          ? [
              identity.invocation.command,
              identity.invocation.prefixArgs,
              ...(identity.invocation.cwd ? [identity.invocation.cwd] : [])
            ]
          : [])
      ])
    )
    .digest('hex')
}

/** The durable record pins the account home at launch, so this names the
 *  catalog THAT session lists from — not whichever account is selected now. */
export function agentModelCatalogIdentityForRecord(
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
): AgentModelCatalogIdentity {
  return {
    agent: record.provider,
    accountHomeVariable: record.accountHome.variable,
    accountHomePath: record.accountHome.path,
    wslDistro: record.location.wslDistro
  }
}

export function agentModelCatalogFingerprintForRecord(
  record: Pick<AgentSessionRecord, 'provider' | 'accountHome' | 'location'>
): string {
  return agentModelCatalogFingerprint(agentModelCatalogIdentityForRecord(record))
}

/** A live session's store handle, pinned to its account home and command invocation.
 *  Native only: both structured adapters refuse non-native locations at launch. */
export function agentModelCatalogSessionAccess(
  store: AgentModelCatalogStore | undefined,
  agent: 'claude' | 'codex',
  accountHomePath: string | null,
  invocation?: StructuredAgentCommandInvocation
): AgentModelCatalogSessionAccess | undefined {
  if (!store || !accountHomePath) {
    return undefined
  }
  const pinned = invocation
    ? {
        command: invocation.command,
        prefixArgs: [...invocation.prefixArgs],
        ...(invocation.cwd ? { cwd: invocation.cwd } : {})
      }
    : undefined
  return {
    store,
    fingerprint: agentModelCatalogFingerprint({
      agent,
      accountHomeVariable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      accountHomePath,
      wslDistro: null,
      ...(pinned ? { invocation: pinned } : {})
    }),
    accountHomePath,
    ...(pinned ? { invocation: pinned } : {})
  }
}

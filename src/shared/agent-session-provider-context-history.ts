import {
  agentSessionProviderContextStart,
  decodePersistedAgentSessionProviderHandleChain,
  encodePersistedAgentSessionProviderHandleChain,
  isAgentSessionProviderHandleChain,
  MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS,
  type AgentSessionProviderHandleChain,
  type AgentSessionProviderHandleLink,
  type PersistedAgentSessionProviderHandleLink
} from './agent-session-provider-handle'
import type { AgentSessionProviderHandleReplacement } from './agent-session-provider-handle-replacement'

export type PersistedAgentSessionProviderContextHistory = {
  version: 1
  links: PersistedAgentSessionProviderHandleLink[]
  replacement: AgentSessionProviderHandleReplacement
}

/** Older writers see only the current context and preserve the record's disjoint archive. */
export function encodeProviderContextHistory(chain: AgentSessionProviderHandleChain): {
  providerHandleChain: PersistedAgentSessionProviderHandleLink[]
  providerContextHistory?: PersistedAgentSessionProviderContextHistory
} {
  const start = agentSessionProviderContextStart(chain)
  const replacement = chain[start]?.replaces
  if (!replacement) {
    return { providerHandleChain: encodePersistedAgentSessionProviderHandleChain(chain) }
  }
  const providerHandleChain = encodePersistedAgentSessionProviderHandleChain(chain.slice(start))
  const { replaces: _replacement, ...first } = providerHandleChain[0]
  providerHandleChain[0] = first
  return {
    providerHandleChain,
    providerContextHistory: {
      version: 1,
      links: encodePersistedAgentSessionProviderHandleChain(chain.slice(0, start)),
      replacement
    }
  }
}

/** Join once, then validate the complete provenance, including the archived/visible seam. */
export function decodeProviderContextHistory(
  visible: unknown,
  history: unknown
): AgentSessionProviderHandleLink[] | null {
  const current = decodePersistedAgentSessionProviderHandleChain(visible)
  if (!current || history === undefined) {
    return current
  }
  if (
    typeof history !== 'object' ||
    history === null ||
    !('version' in history) ||
    history.version !== 1 ||
    !('links' in history) ||
    !('replacement' in history)
  ) {
    return null
  }
  const earlier = decodePersistedAgentSessionProviderHandleChain(history.links)
  const first = current[0]
  if (
    !earlier?.length ||
    !first ||
    first.origin !== 'created' ||
    current.length > MAX_AGENT_SESSION_PROVIDER_HANDLE_LINKS ||
    current.some((link) => link.replaces !== undefined)
  ) {
    return null
  }
  const joined: unknown[] = [
    ...earlier,
    { ...first, replaces: history.replacement },
    ...current.slice(1)
  ]
  return isAgentSessionProviderHandleChain(joined) ? joined : null
}

/**
 * Which structured agents' records a host admits, and what an agent's definition says its records
 * pin.
 *
 * A host admits records only of agents it registered: the runtime hands the record store its
 * registered agents' ids, and a row of any other agent is set aside unread, never rewritten.
 * Whether a readable record's handles and account variable are the ones its agent's definition
 * declares is not the store's question; it is asked only when that agent would start
 * (`agentDrivesSession`). Nothing here names an agent; the list is the runtime's.
 */

import type { AgentSessionProviderTransport } from './agent-session-provider-handle'

/** What an agent's definition says its records pin. */
export type AgentSessionStoredAgent = {
  /** The Orca agent a record names as its `provider`. */
  agent: string
  /** The protocol whose id space this agent's provider handles live in. */
  handleTransport: AgentSessionProviderTransport
  /** Environment variable naming the agent's config directory, pinned as the record's account home. */
  accountHomeVariable: string
}

/** The agents a record store admits: the ids this runtime registered. */
export type AgentSessionStoredAgents = ReadonlySet<string>

export function agentSessionStoredAgents(
  agents: readonly Pick<AgentSessionStoredAgent, 'agent'>[]
): AgentSessionStoredAgents {
  const admitted = new Set<string>()
  for (const { agent } of agents) {
    if (admitted.has(agent)) {
      throw new Error(`structured agent ${agent} is registered twice`)
    }
    admitted.add(agent)
  }
  return admitted
}

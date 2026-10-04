/**
 * What a record of one structured agent may store, as the agent's definition declares it.
 *
 * A host admits records only of agents it registered: the runtime hands its registered agents to
 * the record store, and a row of any other agent is set aside unread, never rewritten. Nothing here
 * names an agent; the list is the runtime's.
 */

import type { AgentSessionProviderTransport } from './agent-session-provider-handle'

export type AgentSessionStoredAgent = {
  /** The Orca agent a record names as its `provider`. */
  agent: string
  /** The protocol whose id space this agent's provider handles live in. */
  handleTransport: AgentSessionProviderTransport
  /** Environment variable naming the agent's config directory, pinned as the record's account home. */
  accountHomeVariable: string
}

/** The agents a record store admits, keyed by agent. */
export type AgentSessionStoredAgents = ReadonlyMap<string, AgentSessionStoredAgent>

export function agentSessionStoredAgents(
  agents: readonly AgentSessionStoredAgent[]
): AgentSessionStoredAgents {
  const byAgent = new Map<string, AgentSessionStoredAgent>()
  for (const { agent, handleTransport, accountHomeVariable } of agents) {
    if (byAgent.has(agent)) {
      throw new Error(`structured agent ${agent} is registered twice`)
    }
    byAgent.set(agent, { agent, handleTransport, accountHomeVariable })
  }
  return byAgent
}

/** Admits only a variable a registered agent declares: a record's variable becomes a child's environment. */
export function isDeclaredAccountHomeVariable(
  agents: AgentSessionStoredAgents,
  value: unknown
): value is string {
  if (typeof value !== 'string') {
    return false
  }
  for (const agent of agents.values()) {
    if (agent.accountHomeVariable === value) {
      return true
    }
  }
  return false
}

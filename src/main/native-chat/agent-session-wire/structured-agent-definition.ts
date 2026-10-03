// What the host knows about a structured agent before any session of it runs.
//
// Each agent's own module declares its definition; shared host code reads the definition and never
// branches on the agent's name. The router routes sessions to adapters registered with these
// definitions, and at-rest reads with no adapter in hand look one up by agent here.

import type { AgentSessionCapabilities } from '../../../shared/agent-session-capabilities'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'

export type StructuredAgentDefinition = {
  /** The Orca agent whose sessions this definition describes. */
  agent: string
  capabilities: AgentSessionCapabilities
  /** How a session's options read and change while no child runs. */
  restingOptions: {
    /** Whether the agent takes a pick of this option key. */
    acceptsKey: (key: string) => boolean
    /** The models a running child falls back to with no catalog; null when it has none. */
    fallbackModels: () => AgentSessionModelOption[] | null
    /** An unpicked effort reads as the model's default effort, as a running child reports it. */
    effortDefaultsToModel: boolean
  }
}

const DEFINITIONS: ReadonlyMap<string, StructuredAgentDefinition> = new Map(
  [CLAUDE_STRUCTURED_AGENT, CODEX_STRUCTURED_AGENT].map((definition) => [
    definition.agent,
    definition
  ])
)

/** The definition of an agent this build drives in structured sessions; null for any other. */
export function structuredAgentDefinition(agent: string): StructuredAgentDefinition | null {
  return DEFINITIONS.get(agent) ?? null
}

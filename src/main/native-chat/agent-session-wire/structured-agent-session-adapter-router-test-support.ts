import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import type { StructuredAgentDefinition } from './structured-agent-definition'

/** A router with this build's two agents registered under their real definitions. */
export function claudeAndCodexRouter(
  adapters: { claude: StructuredAgentSessionAdapter; codex: StructuredAgentSessionAdapter },
  closeAdapters: () => Promise<void>
): StructuredAgentSessionAdapterRouter {
  return new StructuredAgentSessionAdapterRouter(
    [
      { definition: CLAUDE_STRUCTURED_AGENT, adapter: adapters.claude },
      { definition: CODEX_STRUCTURED_AGENT, adapter: adapters.codex }
    ],
    closeAdapters
  )
}

/** The router's definition lookup over the same two agents, for a double that stands in for it. */
export function claudeAndCodexDefinition(agent: string): StructuredAgentDefinition | null {
  return [CLAUDE_STRUCTURED_AGENT, CODEX_STRUCTURED_AGENT].find((d) => d.agent === agent) ?? null
}

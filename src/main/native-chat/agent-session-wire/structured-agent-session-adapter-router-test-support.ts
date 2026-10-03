import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'

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

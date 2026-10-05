import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentType } from '../../shared/agent-status-types'
import {
  resolveCompatibleAgentTypeForOwner,
  type CompatibleAgentOwnerOptions
} from '../../shared/agent-title-owner'
import type { TerminalConversationIdentity } from '../../shared/terminal-conversation-identity'
import type { StoredAgentConversationRead } from '../agent-hooks/server/server-types'

export type GetAgentConversationForPane = (
  paneKey: string,
  terminalHandle?: string | null
) => StoredAgentConversationRead | undefined

/** Unknown session provenance disproves nothing; a known one must share the agent's compatible group. */
export function providerSessionMatchesAgent(args: {
  sessionAgent: AgentType | null | undefined
  agent: AgentType | null | undefined
  ownerAgent: AgentType | null | undefined
  ownerOptions: CompatibleAgentOwnerOptions
}): boolean {
  const sessionAgent = resolveCompatibleAgentTypeForOwner(
    args.sessionAgent,
    args.ownerAgent,
    args.ownerOptions
  )
  return !args.agent || !sessionAgent || args.agent === sessionAgent
}

/** A status row's address, for stores or rows that hold no facet. */
export type LegacyIdentityCandidate = {
  providerSession: AgentProviderSessionMetadata
  /** The agent that reported this session, when the row recorded it. */
  sessionAgent: AgentType | null
  model?: string
  modelSwitchCommand?: 'orca-model'
  capturedAt: number
  source: 'legacy-row' | 'renderer'
}

/**
 * The pane's published identity, or `undefined` (absent) when the host holds none it can vouch for
 * here. A facet is published only for the agent the pane holds now: the row's current agent, else
 * the launch/foreground owner; another agent's conversation is withheld, never published as empty.
 */
export function resolveTerminalConversationIdentity(args: {
  stored: StoredAgentConversationRead | undefined
  legacy: LegacyIdentityCandidate | null
  ownerAgent: AgentType | null
  ownerOptions: CompatibleAgentOwnerOptions
}): TerminalConversationIdentity | undefined {
  const { stored, ownerAgent, ownerOptions } = args
  if (stored) {
    const facet = stored.facet
    // Why the row first: launch provenance outlives its agent; the row follows a hand-started one.
    const paneAgent = stored.rowAgent ?? ownerAgent
    if (
      !providerSessionMatchesAgent({
        sessionAgent: facet.agentType,
        agent: paneAgent,
        ownerAgent: paneAgent,
        ownerOptions
      })
    ) {
      return undefined
    }
    return {
      ...facet,
      agentType:
        resolveCompatibleAgentTypeForOwner(
          facet.agentType,
          ownerAgent ?? paneAgent,
          ownerOptions
        ) ?? facet.agentType,
      source: stored.rowIsRemnant ? 'retained' : 'live'
    }
  }
  const legacy = args.legacy
  // Why: an aged remnant with no launch hint keeps its reporting agent as the owner.
  const agentType = ownerAgent ?? legacy?.sessionAgent
  if (
    !legacy ||
    !agentType ||
    !providerSessionMatchesAgent({
      sessionAgent: legacy.sessionAgent,
      agent: agentType,
      ownerAgent,
      ownerOptions
    })
  ) {
    return undefined
  }
  return {
    agentType,
    providerSession: legacy.providerSession,
    ...(legacy.model ? { model: legacy.model } : {}),
    ...(legacy.modelSwitchCommand ? { modelSwitchCommand: legacy.modelSwitchCommand } : {}),
    capturedAt: legacy.capturedAt,
    source: legacy.source
  }
}

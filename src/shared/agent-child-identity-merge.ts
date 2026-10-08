/** Which agent a child is and the model it runs. */
export type AgentChildIdentity = { agentType?: string; model?: string }

/** Agent type and model are one fact: a newly named agent type never inherits the prior one's
 *  model. A type named for the first time keeps a model already reported for the same child. */
export function mergeAgentChildIdentity(
  prior: AgentChildIdentity | undefined,
  observed: AgentChildIdentity
): AgentChildIdentity {
  const agentTypeChanged =
    observed.agentType !== undefined &&
    prior?.agentType !== undefined &&
    observed.agentType !== prior.agentType
  return {
    agentType: observed.agentType ?? prior?.agentType,
    model: observed.model ?? (agentTypeChanged ? undefined : prior?.model)
  }
}

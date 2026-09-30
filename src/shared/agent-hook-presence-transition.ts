import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess } from './agent-process-presence'

function claimsAgent(event: AgentHookEventPayload): boolean {
  const agentType = event.payload.agentType
  return agentType !== undefined && agentType !== 'unknown'
}

/** The pane's presence belongs to one agent process; only that process's evidence changes it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  if (
    previous &&
    claimsAgent(previous) &&
    claimsAgent(incoming) &&
    previous.payload.agentType !== incoming.payload.agentType
  ) {
    return incoming
  }
  const owner = previous?.agentPresence
  const next = incoming.agentPresence
  if (!next) {
    // Why: evidence without an identity can neither extend nor revive the owner's presence.
    return { ...incoming, agentPresence: owner && !owner.ended ? owner : undefined }
  }
  const fromOwner = owner !== undefined && isSameAgentProcess(owner.process, next.process)
  // Why: SessionEnd, or an exit the execution host already proved (relay-forwarded).
  if (incoming.hookEventName === 'SessionEnd' || next.ended) {
    if (!owner || !fromOwner || owner.ended) {
      return undefined
    }
    return { ...incoming, payload: previous.payload, agentPresence: { ...owner, ended: true } }
  }
  if (fromOwner) {
    return owner.ended ? undefined : { ...incoming, agentPresence: owner }
  }
  if (owner && !owner.ended) {
    // Why: nested agents inherit ORCA_PANE_KEY; another process's hooks update status, not ownership.
    return { ...incoming, agentPresence: owner }
  }
  return incoming
}

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
    // Why: an agent of another type started mid-turn is nested; it may report status, not own the pane.
    if (
      previous.payload.state === 'done' ||
      previous.providerSessionOnly ||
      !incoming.agentPresence
    ) {
      return incoming
    }
    return incoming.hookEventName === 'SessionEnd' || incoming.agentPresence.ended
      ? undefined
      : { ...incoming, agentPresence: undefined }
  }
  const owner = previous?.agentPresence
  const next = incoming.agentPresence
  if (!next) {
    // Why: evidence without an identity can neither extend nor revive the owner's presence.
    return owner && !owner.ended ? { ...incoming, agentPresence: owner } : incoming
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

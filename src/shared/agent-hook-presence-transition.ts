import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentProcessIdentity } from './agent-process-presence'

function claimsAgent(event: AgentHookEventPayload): boolean {
  const agentType = event.payload.agentType
  return agentType !== undefined && agentType !== 'unknown'
}

function isOtherProcess(a: AgentProcessIdentity, b: AgentProcessIdentity): boolean {
  return a.pid !== b.pid || a.platform !== b.platform || a.startTime !== b.startTime
}

/** Apply lifecycle evidence only to the session that supplied it. */
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
  const next = incoming.agentPresence
  const prior = previous?.agentPresence
  if (!next && prior?.ended) {
    return undefined
  }
  if (!next) {
    return prior ? { ...incoming, agentPresence: prior } : incoming
  }
  const retired = prior?.ended || prior?.sessionSwitch
  if (incoming.hookEventName === 'SessionEnd') {
    if (!prior || prior.sessionId !== next.sessionId || retired) {
      return undefined
    }
    const switching =
      incoming.hookSessionEndReason === 'clear' || incoming.hookSessionEndReason === 'resume'
    return {
      ...incoming,
      payload: previous.payload,
      providerSession: switching ? undefined : incoming.providerSession,
      agentPresence: { ...prior, ...(switching ? { sessionSwitch: true } : { ended: true }) }
    }
  }
  if (!prior) {
    return incoming
  }
  if (retired) {
    // Why: a late event from the retired session must not revive it; any other session replaces it.
    if (prior.sessionId === next.sessionId && incoming.hookEventName !== 'SessionStart') {
      return undefined
    }
    const process = next.process ?? (prior.sessionSwitch ? prior.process : undefined)
    return { ...incoming, agentPresence: { ...next, process } }
  }
  if (
    prior.sessionId !== next.sessionId &&
    prior.process &&
    next.process &&
    isOtherProcess(prior.process, next.process)
  ) {
    // Why: nested agents inherit ORCA_PANE_KEY; their sessions must not own the pane's presence.
    return { ...incoming, agentPresence: prior }
  }
  return {
    ...incoming,
    agentPresence: {
      ...next,
      process: next.process ?? (prior.sessionId === next.sessionId ? prior.process : undefined)
    }
  }
}

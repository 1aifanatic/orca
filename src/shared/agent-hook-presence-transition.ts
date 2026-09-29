import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

/** Apply lifecycle evidence only to the session that supplied it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  if (previous && previous.payload.agentType !== incoming.payload.agentType) {
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
  if (incoming.hookEventName === 'SessionEnd') {
    if (!prior || prior.sessionId !== next.sessionId || prior.ended) {
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
  if (
    prior &&
    incoming.hookEventName !== 'SessionStart' &&
    (prior.ended || prior.sessionSwitch || prior.sessionId !== next.sessionId)
  ) {
    return undefined
  }
  const sameProcess = !prior?.ended && (prior?.sessionId === next.sessionId || prior?.sessionSwitch)
  return {
    ...incoming,
    agentPresence: { ...next, process: next.process ?? (sameProcess ? prior?.process : undefined) }
  }
}

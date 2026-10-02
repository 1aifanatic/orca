import { isNewTurnEvent } from './agent-hook-listener/provider-event-routing'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'

/** Hooks can prompt a check, but cannot provide a successor process. */
export function ownerDoubtFromHook(
  incoming: AgentHookEventPayload,
  row: AgentHookEventPayload
): boolean {
  return Boolean(
    row.agentPresence?.process &&
    !row.agentPresence.ended &&
    (incoming.hookEventName === 'SessionEnd' || incoming.payload.state !== 'working')
  )
}

/** A pane has one owning agent; only the owner's own proven process can end it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  if (previous?.agentPresence?.ended) {
    return !incoming.isReplay &&
      (incoming.source
        ? isNewTurnEvent(incoming.source, incoming.hookEventName)
        : incoming.payload.state === 'working')
      ? { ...incoming, agentPresence: undefined }
      : undefined
  }
  // Hook bytes never grant or end ownership, including hooks from nested agents.
  return { ...incoming, agentPresence: previous?.agentPresence }
}

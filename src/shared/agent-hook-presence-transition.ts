import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { isSameAgentProcess } from './agent-process-presence'

/** A pane has one owning agent; only the owner's own proven process can end it. */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | undefined {
  const recorded = previous?.agentPresence
  // Dismissing a turn does not release its identified process owner.
  const owner =
    recorded && !recorded.ended && (recorded.process || !previous?.providerSessionOnly)
      ? recorded
      : undefined
  const sender = incoming.agentPresence?.process
  // Why: only an admitted exit is marked ended (Claude's process-ending SessionEnd, or a host-proved
  // exit); other agents' SessionEnd hooks are ordinary status updates.
  const exit = incoming.agentPresence?.ended === true
  // A replay is the relay store’s ordered snapshot, not a new hook from a possibly stale sender.
  if (
    (!exit || incoming.isReplay === true) &&
    incoming.agentPresenceFromExecutionHost &&
    sender &&
    typeof incoming.connectionId === 'string'
  ) {
    return !exit &&
      recorded?.ended &&
      recorded.process &&
      isSameAgentProcess(recorded.process, sender)
      ? undefined
      : incoming
  }
  if (owner) {
    if (exit) {
      const fromOwner = owner.process && sender && isSameAgentProcess(owner.process, sender)
      return fromOwner
        ? {
            ...incoming,
            payload: previous?.payload ?? incoming.payload,
            agentPresence: { ...owner, ended: true }
          }
        : undefined
    }
    // Why: nested agents inherit ORCA_PANE_KEY; their hooks update status, never ownership.
    return incoming.agentPresence === owner ? incoming : { ...incoming, agentPresence: owner }
  }
  if (exit) {
    return undefined
  }
  if (
    recorded?.ended &&
    recorded.process &&
    sender &&
    isSameAgentProcess(recorded.process, sender)
  ) {
    return undefined
  }
  const agent = incoming.agentPresence?.agent ?? incoming.payload.agentType
  if (!agent || agent === 'unknown') {
    return incoming.agentPresence ? { ...incoming, agentPresence: undefined } : incoming
  }
  return { ...incoming, agentPresence: { agent, ...(sender ? { process: sender } : {}) } }
}

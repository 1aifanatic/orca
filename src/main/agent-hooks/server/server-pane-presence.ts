import {
  carryOwnerFields,
  transitionHookPresence,
  transitionTerminalPresence
} from '../../../shared/agent-hook-presence-transition'
import type { PaneOwnerProbes } from '../../../shared/agent-pane-owner-probes'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type {
  AgentProcessIdentity,
  AgentProcessPresence
} from '../../../shared/agent-process-presence'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import type { EnrichedAgentHookEventPayload } from './server-types'

export type PanePresenceDecision =
  | { event: AgentHookEventPayload; probe?: AgentProcessIdentity }
  | { keep: EnrichedAgentHookEventPayload }
  | undefined

function liveOwner(row: AgentHookEventPayload | undefined): AgentProcessPresence | undefined {
  return row?.agentPresence?.ended ? undefined : row?.agentPresence
}

/** Main decides ownership for local panes only; a relayed row's owner was decided by its relay. */
export function decidePanePresence(
  incoming: AgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined,
  origin: AgentStatusObservationOrigin,
  probes: PaneOwnerProbes,
  reapply: () => void
): PanePresenceDecision {
  const context = { now: Date.now(), rowUpdatedAt: previous?.receivedAt }
  if (origin !== 'hook') {
    const terminal = transitionTerminalPresence(incoming, previous, context)
    if (terminal.kind === 'write') {
      return { event: terminal.event }
    }
    // Why: main cannot check a remote owner; its relay does.
    if (terminal.probe && incoming.connectionId === null) {
      probes.probe(incoming.paneKey, terminal.probe)
    }
    return previous ? { keep: previous } : undefined
  }
  if (incoming.connectionId !== null) {
    // Why: host restatements (cancel inference, expiry) carry no owner; the relayed one stands.
    return {
      event: carryOwnerFields(
        incoming.agentPresence ? incoming : { ...incoming, agentPresence: liveOwner(previous) },
        previous
      )
    }
  }
  const transition = transitionHookPresence(incoming, previous, context)
  if (transition.kind === 'drop') {
    return undefined
  }
  if (transition.kind === 'guest') {
    probes.guest(
      incoming.paneKey,
      { producer: transition.producer, holdable: transition.holdable, apply: reapply },
      transition.probe
    )
    return undefined
  }
  return transition
}

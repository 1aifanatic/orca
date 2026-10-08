import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  MAX_OWNER_HELD_SESSIONS,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { isFreshNonDoneAgentStatus } from './agent-status-freshness'

/** Who produced a hook event; compared against the pane's owner (`agentPresence`). */
export type HookProducerIdentity = {
  agent: string | undefined
  session?: string
  process?: AgentProcessIdentity
  /** Sessions of other agent types this producer runs inside (own-type markers prove nothing). */
  nestedIn: string[]
}

export type HookPresenceTransition =
  | {
      kind: 'write'
      event: AgentHookEventPayload
      /** Owner process another producer cast doubt on; the host checks it without waiting. */
      probe?: AgentProcessIdentity
    }
  | {
      kind: 'guest'
      /** Stable per-producer key, so a later event of the same guest replaces its held one. */
      producer: string
      /** A live guest event may take the pane if the probe it started finds the owner exited. */
      holdable: boolean
      probe?: AgentProcessIdentity
    }
  | { kind: 'drop' }

export type HookPresenceContext = {
  now: number
  /** When the owner last wrote the row; guests never refresh it. */
  rowUpdatedAt: number | undefined
}

export function readHookProducer(incoming: AgentHookEventPayload): HookProducerIdentity {
  const agent = incoming.agentPresence?.agent ?? incoming.payload.agentType
  return {
    agent: agent && agent !== 'unknown' ? agent : undefined,
    session: incoming.providerSession?.id,
    process: incoming.agentPresence?.process,
    nestedIn: (incoming.nestedIn ?? [])
      .filter((entry) => entry.agent !== agent)
      .map((entry) => entry.session)
  }
}

function ownerSessions(owner: AgentProcessPresence): string[] {
  return owner.session ? [owner.session, ...(owner.heldSessions ?? [])] : (owner.heldSessions ?? [])
}

function sameProcess(
  a: AgentProcessIdentity | undefined,
  b: AgentProcessIdentity | undefined
): boolean {
  return a !== undefined && b !== undefined && isSameAgentProcess(a, b)
}

/** PLAN rules 1-4, first match wins. */
function classifyAgainstOwner(
  producer: HookProducerIdentity,
  owner: AgentProcessPresence,
  previous: AgentHookEventPayload,
  context: HookPresenceContext
): 'owner' | 'guest' | 'claim' {
  const held = ownerSessions(owner)
  if (
    (producer.session !== undefined && held.includes(producer.session)) ||
    sameProcess(producer.process, owner.process)
  ) {
    return 'owner'
  }
  if (producer.nestedIn.some((session) => held.includes(session))) {
    return 'guest'
  }
  if (producer.agent === undefined || producer.agent === owner.agent) {
    return 'owner'
  }
  // Why: only an owner the host cannot check falls back to freshness; a restored one never blocks.
  const ownerReleased =
    previous.restoredUnconfirmed === true ||
    (owner.process === undefined &&
      !isFreshNonDoneAgentStatus(
        { state: previous.payload.state, updatedAt: context.rowUpdatedAt ?? 0 },
        context.now
      ))
  return ownerReleased ? 'claim' : 'guest'
}

function withOwnerSession(
  owner: AgentProcessPresence,
  producer: HookProducerIdentity
): AgentProcessPresence {
  const session = producer.session
  // Why: a different process of the owner's type is not the owner, so it never rotates its session.
  if (
    !session ||
    session === owner.session ||
    (producer.process && owner.process && !isSameAgentProcess(producer.process, owner.process))
  ) {
    return owner
  }
  const heldSessions = ownerSessions(owner)
    .filter((held) => held !== session)
    .slice(0, MAX_OWNER_HELD_SESSIONS)
  return { ...owner, session, ...(heldSessions.length > 0 ? { heldSessions } : {}) }
}

/** The owner's own sparse events (child hooks, a relay that restarted) keep its model and session. */
export function carryOwnerFields(
  event: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload {
  if (
    !previous ||
    previous.providerSessionOnly ||
    previous.agentPresence?.ended ||
    previous.payload.agentType !== event.payload.agentType
  ) {
    return event
  }
  const providerSession = event.providerSession ?? previous.providerSession
  const model = event.payload.model ?? previous.payload.model
  if (providerSession === event.providerSession && model === event.payload.model) {
    return event
  }
  return {
    ...event,
    ...(providerSession ? { providerSession } : {}),
    payload: model ? { ...event.payload, model } : event.payload
  }
}

function guestKey(producer: HookProducerIdentity): string {
  const process = producer.process
  return [
    producer.agent ?? '',
    producer.session ?? '',
    process ? `${process.pid}:${process.startTime}` : ''
  ].join('|')
}

/** A pane has one owning agent. Only the owner's hook events write the row; a different agent's are
 *  guests until the owner is proven gone. Shared by main (local rows) and the relay (remote rows). */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  context: HookPresenceContext
): HookPresenceTransition {
  const { nestedIn: _nestedIn, ...event } = incoming
  const recorded = previous?.agentPresence
  const owner = recorded && !recorded.ended && !previous?.providerSessionOnly ? recorded : undefined
  const producer = readHookProducer(incoming)
  // Why: only an admitted exit is marked ended (Claude's process-ending SessionEnd, or a host-proved
  // exit); other agents' SessionEnd hooks are ordinary status updates.
  const exit = incoming.agentPresence?.ended === true
  const verdict =
    owner && previous ? classifyAgainstOwner(producer, owner, previous, context) : 'claim'
  if (owner && verdict === 'guest') {
    return { kind: 'guest', producer: guestKey(producer), holdable: !exit, probe: owner.process }
  }
  if (owner && verdict === 'owner') {
    if (exit) {
      return sameProcess(owner.process, producer.process)
        ? {
            kind: 'write',
            event: {
              ...event,
              payload: previous?.payload ?? event.payload,
              agentPresence: { ...owner, ended: true }
            }
          }
        : { kind: 'drop' }
    }
    const nextOwner = withOwnerSession(owner, producer)
    const probe =
      producer.process && owner.process && !isSameAgentProcess(producer.process, owner.process)
        ? owner.process
        : undefined
    return {
      kind: 'write',
      event: carryOwnerFields({ ...event, agentPresence: nextOwner }, previous),
      ...(probe ? { probe } : {})
    }
  }
  if (exit || (recorded?.ended && sameProcess(recorded.process, producer.process))) {
    return { kind: 'drop' }
  }
  // Why: a producer nested inside another agent's session never takes an ownerless pane, so a
  // restart that brings both back cannot hand the pane to the nested one.
  if (!owner && producer.nestedIn.length > 0) {
    return { kind: 'guest', producer: guestKey(producer), holdable: false }
  }
  if (!producer.agent) {
    return { kind: 'write', event: { ...event, agentPresence: undefined } }
  }
  return {
    kind: 'write',
    event: {
      ...event,
      agentPresence: {
        agent: producer.agent,
        ...(producer.process ? { process: producer.process } : {}),
        ...(producer.session ? { session: producer.session } : {})
      }
    }
  }
}

/** Terminal signals (OSC, titles, process-derived rows) never claim and never become guests: they
 *  write the row under its current owner. One naming another agent asks the host to check the owner. */
export function transitionTerminalPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): { event: AgentHookEventPayload; probe?: AgentProcessIdentity } {
  const recorded = previous?.agentPresence?.ended ? undefined : previous?.agentPresence
  const event = { ...incoming, agentPresence: recorded }
  const agent = incoming.payload.agentType
  const probe =
    recorded?.process &&
    !previous?.providerSessionOnly &&
    agent &&
    agent !== 'unknown' &&
    agent !== recorded.agent
      ? recorded.process
      : undefined
  return probe ? { event, probe } : { event }
}

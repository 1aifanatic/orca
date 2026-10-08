import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  MAX_OWNER_HELD_SESSIONS,
  type AgentProcessIdentity,
  type AgentProcessPresence
} from './agent-process-presence'
import { isFreshNonDoneAgentStatus } from './agent-status-freshness'

/** `write` stores the event; `skip` leaves the row unchanged. `probe` is an owner process another
 *  producer cast doubt on; on `skip` it also means the event is held until that owner is gone. */
export type HookPresenceTransition =
  | { kind: 'write'; event: AgentHookEventPayload; probe?: AgentProcessIdentity }
  | { kind: 'skip'; probe?: AgentProcessIdentity }

type HookProducer = {
  agent: string | undefined
  session?: string
  process?: AgentProcessIdentity
  /** Sessions of other agent types this producer runs inside (own-type markers prove nothing). */
  nestedIn: string[]
}

/** The pane's owner. An ended owner, or an identity-only row (a resume remnant, a Pi session
 *  announcement), holds no pane. */
export function currentOwner(
  row: AgentHookEventPayload | undefined
): AgentProcessPresence | undefined {
  return row?.agentPresence && !row.agentPresence.ended && !row.providerSessionOnly
    ? row.agentPresence
    : undefined
}

function readHookProducer(incoming: AgentHookEventPayload): HookProducer {
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

function otherProcess(
  a: AgentProcessIdentity | undefined,
  b: AgentProcessIdentity | undefined
): boolean {
  return a !== undefined && b !== undefined && !isSameAgentProcess(a, b)
}

// Why: only an owner the host cannot check falls back to freshness; a restored one never blocks.
function isOwnerReleased(
  owner: AgentProcessPresence,
  row: AgentHookEventPayload,
  rowUpdatedAt: number | undefined,
  now: number
): boolean {
  return (
    row.restoredUnconfirmed === true ||
    (owner.process === undefined &&
      !isFreshNonDoneAgentStatus({ state: row.payload.state, updatedAt: rowUpdatedAt ?? 0 }, now))
  )
}

/** PLAN rules 1-4, first match wins: proven guests (rule 2) need no liveness check. */
function classifyAgainstOwner(
  producer: HookProducer,
  owner: AgentProcessPresence,
  previous: AgentHookEventPayload,
  rowUpdatedAt: number | undefined,
  now: number
): 'owner' | 'nested' | 'guest' | 'claim' {
  const held = ownerSessions(owner)
  if (
    (producer.session !== undefined && held.includes(producer.session)) ||
    sameProcess(producer.process, owner.process)
  ) {
    return 'owner'
  }
  if (producer.nestedIn.some((session) => held.includes(session))) {
    return 'nested'
  }
  if (producer.agent === undefined || producer.agent === owner.agent) {
    return 'owner'
  }
  return isOwnerReleased(owner, previous, rowUpdatedAt, now) ? 'claim' : 'guest'
}

function withOwnerSession(
  owner: AgentProcessPresence,
  producer: HookProducer
): AgentProcessPresence {
  const session = producer.session
  // Why: a different process of the owner's type is not the owner, so it never rotates its session.
  if (!session || session === owner.session || otherProcess(producer.process, owner.process)) {
    return owner
  }
  const heldSessions = ownerSessions(owner)
    .filter((held) => held !== session)
    .slice(0, MAX_OWNER_HELD_SESSIONS)
  return { ...owner, session, ...(heldSessions.length > 0 ? { heldSessions } : {}) }
}

/** The owner's own sparse events (child hooks, a relay that restarted) keep its model and session;
 *  a restarted process of the same type starts clean. */
function carryOwnerFields(
  event: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload {
  if (
    !previous ||
    previous.providerSessionOnly ||
    previous.agentPresence?.ended ||
    previous.payload.agentType !== event.payload.agentType ||
    otherProcess(event.agentPresence?.process, previous.agentPresence?.process)
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

/** A pane has one owning agent. Only the owner's hook events write the row; a different agent's are
 *  guests until the owner is proven gone. Shared by main (local rows) and the relay (remote rows). */
export function transitionHookPresence(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined,
  rowUpdatedAt: number | undefined,
  now = Date.now()
): HookPresenceTransition {
  const { nestedIn: _nestedIn, ...event } = incoming
  const owner = currentOwner(previous)
  const producer = readHookProducer(incoming)
  // Why: only an admitted exit is marked ended (Claude's process-ending SessionEnd, or a host-proved
  // exit); other agents' SessionEnd hooks are ordinary status updates.
  const exit = incoming.agentPresence?.ended === true
  const verdict =
    owner && previous ? classifyAgainstOwner(producer, owner, previous, rowUpdatedAt, now) : 'claim'
  if (verdict === 'nested') {
    return { kind: 'skip' }
  }
  if (owner && verdict === 'guest') {
    return exit || !owner.process ? { kind: 'skip' } : { kind: 'skip', probe: owner.process }
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
        : { kind: 'skip' }
    }
    const probe = otherProcess(producer.process, owner.process) ? owner.process : undefined
    return {
      kind: 'write',
      event: {
        ...carryOwnerFields(event, previous),
        agentPresence: withOwnerSession(owner, producer)
      },
      ...(probe ? { probe } : {})
    }
  }
  const ended = previous?.agentPresence?.ended ? previous.agentPresence : undefined
  // Why: a producer nested inside another agent's session never takes an ownerless pane, so a
  // restart that brings both back cannot hand the pane to the nested one.
  if (exit || sameProcess(ended?.process, producer.process) || producer.nestedIn.length > 0) {
    return { kind: 'skip' }
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

/** Main adopts a relayed row as its relay built it; host restatements (cancel inference, expiry)
 *  carry no owner, so the relayed one stands. */
export function adoptRelayedRow(
  incoming: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload {
  return carryOwnerFields(
    incoming.agentPresence ? incoming : { ...incoming, agentPresence: currentOwner(previous) },
    previous
  )
}

/** A terminal signal (OSC, title, process-derived) naming another agent than a held owner yields:
 *  terminals never claim, so it leaves the row unchanged and only casts doubt on the owner. */
export function terminalSignalYieldsToOwner(
  previous: (AgentHookEventPayload & { receivedAt: number }) | undefined,
  agentType: string | undefined,
  now = Date.now()
): boolean {
  const owner = currentOwner(previous)
  return Boolean(
    owner &&
    previous &&
    agentType &&
    agentType !== 'unknown' &&
    agentType !== owner.agent &&
    !isOwnerReleased(owner, previous, previous.receivedAt, now)
  )
}

/** Terminal signals write under the owner only when they name it (or no agent); one naming another
 *  agent after the owner was released leaves the pane ownerless. */
export function terminalSignalOwner(
  previous: AgentHookEventPayload | undefined,
  agentType: string | undefined
): AgentProcessPresence | undefined {
  const owner = currentOwner(previous)
  return owner && (!agentType || agentType === 'unknown' || agentType === owner.agent)
    ? owner
    : undefined
}

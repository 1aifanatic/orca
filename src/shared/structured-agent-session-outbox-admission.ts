// Which outbox entry goes out next, and which ones wait for the user.

import type { AgentSessionWireRefusalCode } from './agent-session-wire'
import type { StructuredAgentSessionOutboxEntry } from './structured-agent-session-outbox'

/** A send the user was told did not go through, with a Retry: only that Retry sends it again. Read
 *  from the saved failure, so a relaunch holds it exactly as the refusal did. */
export function structuredAgentSessionEntryHeldForRetry(
  entry: StructuredAgentSessionOutboxEntry
): boolean {
  return entry.state === 'queued' && entry.lastFailure !== undefined
}

// What a host from before accepted sends refuses with while it restarts the chat's agent inside the
// send (its restart failed, or met an owner still settling); a new owner is what answers them.
const REFUSED_FOR_OWNER: ReadonlySet<AgentSessionWireRefusalCode> = new Set([
  'agent_session_owner_restart_failed',
  'agent_session_checkpoint_stale',
  'agent_session_conflict',
  'agent_session_ownership_unknown',
  'execution_owner_reconciling'
])

/** On a host known to be older, a held message that host's next owner sends again. */
export function structuredAgentSessionEntryWaitsForNewOwner(
  entry: StructuredAgentSessionOutboxEntry
): boolean {
  return (
    structuredAgentSessionEntryHeldForRetry(entry) &&
    entry.lastFailure?.kind === 'refused' &&
    REFUSED_FOR_OWNER.has(entry.lastFailure.code)
  )
}

export type StructuredAgentSessionOutboxAdmission =
  | { state: 'dispatch'; entry: StructuredAgentSessionOutboxEntry }
  | { state: 'blocked'; entry: StructuredAgentSessionOutboxEntry }
  | { state: 'idle'; entry: null }

/**
 * What the queue does next. The drain and the Retry affordance both read it, so neither can
 * disagree with the other about which entry is holding the queue.
 *
 * A `dispatching` entry is not a barrier: the host appended its journal row inside the
 * per-session serialize chain before dispatching, so nothing behind it can overtake it, and
 * waiting for its echo costs delivery of everything queued behind it. An `unconfirmed` entry
 * is a barrier — sending past it would reorder around a message that may yet land. One the
 * user was told did not go through is not: it lands only by its own Retry, so what the user
 * sends after it goes out as they send it.
 */
export function admitStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[]
): StructuredAgentSessionOutboxAdmission {
  for (const entry of entries) {
    if (entry.state === 'rejected' || structuredAgentSessionEntryHeldForRetry(entry)) {
      continue
    }
    if (entry.state === 'unconfirmed') {
      return { state: 'blocked', entry }
    }
    // A queue send a Stop outlived goes again only on the user's Retry.
    if (entry.state === 'queued') {
      return { state: entry.outlivedStop === true ? 'blocked' : 'dispatch', entry }
    }
  }
  return { state: 'idle', entry: null }
}

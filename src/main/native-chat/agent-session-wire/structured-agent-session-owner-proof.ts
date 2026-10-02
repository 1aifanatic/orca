// What this host knows in memory about a session's owner: the child it runs, the exit of that child
// it watched, and whether an acquisition of its own is under way.
//
// Only an owner this host recorded at the lease's current fence is spoken for. A fence is granted by
// exactly one acquisition, and this host's store is the only writer, so a child or an ended child at
// that fence IS the lease's owner. An owner on any other host gets nothing from memory: only a probe
// may speak for it, and it answers `indeterminate`.

import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import {
  agentSessionLeaseFreeEvidence,
  deriveAgentSessionLeaseState,
  type AgentSessionHostProof
} from '../../../shared/agent-session-lease-state'
import type {
  AgentSessionDeathEvidence,
  AgentSessionLease,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { MAX_UNEXPECTED_EXIT_REASON_CHARS } from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export function structuredAgentSessionOwnerProof(input: {
  lease: AgentSessionLease
  hostId: string
  session: Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'> | undefined
  attemptInFlight: boolean
}): AgentSessionHostProof {
  const { lease, session } = input
  const fence = lease.runtimeFence
  const proof = { fence, attemptInFlight: input.attemptInFlight }
  if (lease.ownerProcess?.hostId !== input.hostId) {
    return { ...proof, owner: { kind: 'none' } }
  }
  if (session?.child?.fence === fence) {
    return { ...proof, owner: { kind: 'runs' } }
  }
  const ended = session?.lastEndedChild
  if (!session?.child && ended?.fence === fence && ended.rootGone) {
    return {
      ...proof,
      owner: {
        kind: 'watched-exit',
        observedAt: ended.observedAt,
        // A stop's release says only that the surface let go; an exit carries the provider's reason.
        reason:
          ended.cause === 'exit' && ended.reason
            ? ended.reason.slice(0, MAX_UNEXPECTED_EXIT_REASON_CHARS)
            : null
      }
    }
  }
  return { ...proof, owner: { kind: 'none' } }
}

/** The proof for a caller inside the session's serialize, where no acquisition can be in flight. */
export function structuredAgentSessionOwnerProofUnderSerialize(
  context: {
    deps: { store: Pick<AgentSessionRecordStore, 'getRecord' | 'hostId'> }
    sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  },
  sessionId: string
): AgentSessionHostProof | null {
  const { store } = context.deps
  const record = store.getRecord(sessionId)
  return record
    ? structuredAgentSessionOwnerProof({
        lease: record.lease,
        hostId: store.hostId,
        session: context.sessions.get(sessionId),
        attemptInFlight: false
      })
    : null
}

/** The probe an acquisition's compare-and-swap reads. A watched exit is `exit-observed`, the
 *  vocabulary's own word for it; this host's child echoed the reserved token when its identity was
 *  committed. No record means nothing was ever reserved. */
export function structuredAgentSessionAcquisitionProbe(
  proof: AgentSessionHostProof | null
): AgentSessionOwnerProbe {
  switch (proof?.owner.kind) {
    case undefined:
      return { outcome: 'reservation-unused' }
    case 'watched-exit':
      return { outcome: 'exit-observed' }
    case 'probed':
      return proof.owner.probe
    case 'runs':
      return { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
    case 'none':
      return { outcome: 'indeterminate', reason: 'an acquisition of this host is in flight' }
  }
}

/** How the previous generation ended, as the lease derives it: a release that never landed still
 *  settles what that generation left running from the proof that would have written it. */
export function structuredAgentSessionPriorDeathEvidence(
  record: AgentSessionRecord | null,
  proof: AgentSessionHostProof | null,
  now: number
): AgentSessionDeathEvidence | null {
  if (!record) {
    return null
  }
  const state = deriveAgentSessionLeaseState(record.lease, proof)
  return state.state === 'free'
    ? agentSessionLeaseFreeEvidence(record.lease, state.basis, now)
    : record.lease.deathEvidence
}

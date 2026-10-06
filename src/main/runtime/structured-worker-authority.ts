/**
 * Resolves a structured worker handle to the same authority facts a live PTY supplies.
 *
 * The registry holds the handle→session mapping for this process; the durable worker-terminal
 * resource row is what survives a restart, so a miss falls back to rehydrating from it. The
 * durable agent-session record, the chat's tab and the orchestration's own resource row decide
 * custody: see `structured-worker-custody`.
 * Whether its provider process runs is a separate fact, `observeStructuredWorker`, and routing
 * never reads it — an agent at rest still receives mail, which starts it.
 *
 * A worker is addressed by the session minted for it, its conversation id; a `/clear` continues the
 * conversation in a successor session. Every worker-level answer here resolves the session RUNNING
 * the worker now through `structuredWorkerSession`; only per-session callers name one directly.
 */

import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { isOrcaSessionId, type OrcaSessionId } from '../../shared/orca-session-address'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../shared/orchestration-session-caller-codes'
import type { RuntimeTerminalState } from '../../shared/runtime-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { canonicalOrcaSessionId } from './orchestration/canonical-orca-session-id'
import type { OrchestrationDb } from './orchestration/db'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  readAgentSessionRecordStore,
  resolveLineageRunningSession,
  type LineageRunningSession
} from './orchestration/structured-session-lineage'
import { structuredWorkerAddressable } from './structured-worker-custody'
import {
  isStructuredWorkerHandle,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation,
  type StructuredWorkerIdentity
} from './structured-worker-identity'

export type StructuredWorkerAuthority = {
  identity: StructuredWorkerIdentity
  /** The session running the worker now, which may be a `/clear` successor, and its record. */
  sessionId: string
  record: AgentSessionRecord
}

export function readStructuredAgentSessionRecord(sessionId: string): AgentSessionRecord | null {
  try {
    return getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId) ?? null
  } catch {
    return null
  }
}

/** Registry entry for a handle, rehydrated from the durable row when this process restarted. */
export function resolveStructuredWorkerIdentity(
  handle: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerIdentity | null {
  if (!isStructuredWorkerHandle(handle)) {
    return null
  }
  const known = structuredWorkerIdentities.get(handle)
  if (known) {
    return known
  }
  const row = db?.getWorkerTerminalResourceByHandle?.(handle)
  return row ? structuredWorkerIdentities.rehydrate(row) : null
}

/** The worker a session runs for: minted for it, or one a `/clear` continued into it. */
export function resolveStructuredWorkerIdentityForSession(
  sessionId: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerIdentity | null {
  const exact = structuredWorkerIdentities.getBySessionId(sessionId)
  if (exact) {
    return exact
  }
  const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  const known = root === sessionId ? null : structuredWorkerIdentities.getBySessionId(root)
  if (known) {
    return known
  }
  const row = db?.getWorkerTerminalResourceByProcessIncarnation?.(
    structuredWorkerProcessIncarnation(root)
  )
  return row ? structuredWorkerIdentities.rehydrate(row) : null
}

/**
 * Whether this session was assigned a Dispatch as a structured worker. Such a session acts with its
 * worker handle, so one whose handle is gone must not act handle-less, as a chat would.
 */
export function isRecordedStructuredWorkerSession(
  sessionId: OrcaSessionId,
  db: OrchestrationDb
): boolean {
  return Boolean(
    db.db
      .prepare(
        `SELECT 1 FROM dispatch_contexts
         WHERE assignee_orca_session_id = ? AND process_incarnation = ? LIMIT 1`
      )
      .get(sessionId, structuredWorkerProcessIncarnation(sessionId))
  )
}

/** The session running this worker now: the one minted for it, or its `/clear` successor. */
export function structuredWorkerSession(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): LineageRunningSession {
  return resolveLineageRunningSession(readAgentSessionRecordStore(), identity.sessionId)
}

/** The worker's running session on this host, or the typed refusal; nothing is done before it. */
export function requireStructuredWorkerSession(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): Extract<LineageRunningSession, { kind: 'here' }> {
  const running = structuredWorkerSession(identity)
  if (running.kind === 'here') {
    return running
  }
  throw running.kind === 'other-host'
    ? new OrchestrationError(
        CODES.hostBoundary,
        `Structured session ${running.sessionId} runs this worker on another host; act on it from that host. No effects were applied.`,
        { effectsApplied: false }
      )
    : new OrchestrationError(
        CODES.notLive,
        `The session running this structured worker cannot be verified: ${running.reason} No effects were applied.`,
        { effectsApplied: false }
      )
}

/** Custody judged on the session running the worker; null when that session cannot be verified. */
export function structuredWorkerCustody(
  identity: StructuredWorkerIdentity,
  db: OrchestrationDb | null | undefined,
  row = db?.getWorkerTerminalResourceByHandle?.(identity.handle)
): { addressable: boolean; sessionId: string; record: AgentSessionRecord } | null {
  const running = structuredWorkerSession(identity)
  if (running.kind === 'unverifiable') {
    return null
  }
  const addressable = structuredWorkerAddressable(db, running.sessionId, row)
  return addressable === null
    ? null
    : { addressable, sessionId: running.sessionId, record: running.record }
}

/** Identity plus the running session's record, for a worker this runtime owns and its
 *  orchestration has not released. */
export function resolveStructuredWorkerAuthority(
  handle: string,
  db: OrchestrationDb | null | undefined
): StructuredWorkerAuthority | null {
  const identity = resolveStructuredWorkerIdentity(handle, db)
  const custody = identity ? structuredWorkerCustody(identity, db) : null
  return identity && custody?.addressable
    ? { identity, sessionId: custody.sessionId, record: custody.record }
    : null
}

/**
 * Which provider this worker actually talks to.
 *
 * The registry carries it only for a session THIS process started; a rehydrated entry has null,
 * because the durable worker-terminal row does not record a provider. The durable agent-session
 * record does, and it is the only source that survives a restart — defaulting instead would
 * relabel every restarted Codex worker as Claude, permanently, because the startup release
 * reconciler stamps the frozen journal archive with whatever it is told here.
 */
export function structuredWorkerAgent(identity: StructuredWorkerIdentity): 'claude' | 'codex' {
  if (identity.agent) {
    return identity.agent
  }
  const running = structuredWorkerSession(identity)
  return running.kind === 'unverifiable' ? 'claude' : running.record.provider
}

export type StructuredWorkerObservation = {
  status: 'live' | 'unverifiable' | 'exited'
  reason?: string
}

/**
 * Whether a close left nothing running: `exited`, or `unverifiable` on a released lease — a release
 * whose stop could not be proven, which sent no signal and is left as it is. Closing a chat is the
 * user's action, and bookkeeping about a process already released must not refuse it.
 */
export function structuredSessionCloseSettled(sessionId: string): boolean {
  const status = observeStructuredSession(sessionId).status
  return (
    status === 'exited' ||
    (status === 'unverifiable' &&
      readStructuredAgentSessionRecord(sessionId)?.lease.claimStatus === 'released')
  )
}

/**
 * The observation as the terminal state every read result reports.
 *
 * `unverifiable` must never render as `running`: losing sight of the structured host is not
 * evidence its child is alive, and the PTY sibling maps the same verdict to `unknown`.
 */
export function structuredWorkerTerminalState(
  liveness: StructuredWorkerObservation['status']
): RuntimeTerminalState {
  return liveness === 'exited' ? 'exited' : liveness === 'live' ? 'running' : 'unknown'
}

/**
 * A worker's liveness, observed on the session running it now. Only the session id is needed: the
 * durable agent-session records are the authority, and they outlive both the in-memory identity
 * registry and this process. Callers that hold nothing but a process incarnation therefore do not
 * have to resolve a registry entry first — after `forget` there is none, and gating on one answers
 * `unverifiable` forever.
 */
export function observeStructuredWorker(
  identity: Pick<StructuredWorkerIdentity, 'sessionId'>
): StructuredWorkerObservation {
  const running = structuredWorkerSession(identity)
  if (running.kind === 'here') {
    return observeStructuredSession(running.sessionId)
  }
  return {
    status: 'unverifiable',
    reason:
      running.kind === 'other-host'
        ? 'The session running this worker is on another host.'
        : running.reason
  }
}

/** One session's own liveness, for callers that act on that session rather than on a worker. */
export function observeStructuredSession(sessionId: string): StructuredWorkerObservation {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    // Reading the persisted record store here would force-install the host, which is itself a side
    // effect; not being able to look is not evidence the child is gone.
    return {
      status: 'unverifiable',
      reason: 'The structured agent-session host is not installed in this runtime generation.'
    }
  }
  const record = host.deps.store.getRecord(sessionId)
  if (!record) {
    return { status: 'unverifiable', reason: 'No durable record backs this structured session.' }
  }
  if (record.lease.claimStatus === 'released' && record.lease.deathEvidence) {
    return { status: 'exited' }
  }
  if (host.hasSession(sessionId) && record.lease.claimStatus === 'live') {
    return { status: 'live' }
  }
  return {
    status: 'unverifiable',
    reason: 'The session has no attached provider child in this runtime generation.'
  }
}

import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import {
  agentSessionScopeKey,
  isAgentSessionDeathEvidence,
  isAgentSessionExecutionLocation,
  isAgentSessionId,
  type AgentSessionDeathEvidence,
  type AgentSessionExecutionLocation,
  type AgentSessionProcessIdentity,
  type AgentSessionRecord
} from '../../shared/agent-session-record'

/** A past ownership fact, scoped to its execution host; never an outstanding cleanup flag. */
export type AgentSessionClosedOwner = {
  schemaVersion: 1
  sessionId: string
  location: AgentSessionExecutionLocation
  deadOwnerFence: number
  evidence: AgentSessionDeathEvidence & { ownerFence: number }
  process: Omit<AgentSessionProcessIdentity, 'spawnToken'> | null
  journalBoundary: AgentJournalCursor | null
}

export function agentSessionClosedOwnerKey(
  owner: Pick<AgentSessionClosedOwner, 'location' | 'sessionId' | 'deadOwnerFence'>
): string {
  return JSON.stringify([
    agentSessionScopeKey(owner.location),
    owner.sessionId,
    owner.deadOwnerFence
  ])
}

export function closedAgentSessionOwner(
  record: AgentSessionRecord,
  evidence: AgentSessionDeathEvidence
): AgentSessionClosedOwner | null {
  if (evidence.ownerFence === undefined) {
    return null
  }
  const owner = record.lease.runtimeFence === evidence.ownerFence ? record.lease.ownerProcess : null
  return {
    schemaVersion: 1,
    sessionId: record.sessionId,
    location: {
      executionHostId: record.location.executionHostId,
      wslDistro: record.location.wslDistro,
      workspaceId: record.location.workspaceId,
      workspaceKind: record.location.workspaceKind
    },
    deadOwnerFence: evidence.ownerFence,
    evidence: {
      kind: evidence.kind,
      detail: evidence.detail,
      observedAt: evidence.observedAt,
      ownerFence: evidence.ownerFence,
      ...(evidence.lastProvenAliveAt === undefined
        ? {}
        : { lastProvenAliveAt: evidence.lastProvenAliveAt }),
      ...(evidence.runtimeEnd === undefined ? {} : { runtimeEnd: evidence.runtimeEnd })
    },
    process: owner
      ? {
          hostId: owner.hostId,
          pid: owner.pid,
          processStartTimeMs: owner.processStartTimeMs,
          ...(owner.runtime ? { runtime: owner.runtime } : {})
        }
      : null,
    journalBoundary: null
  }
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function bounded(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function isClosedOwnerProcess(value: unknown): value is AgentSessionClosedOwner['process'] {
  return (
    value === null ||
    (typeof value === 'object' &&
      'hostId' in value &&
      bounded(value.hostId) &&
      'pid' in value &&
      natural(value.pid) &&
      value.pid > 0 &&
      'processStartTimeMs' in value &&
      (value.processStartTimeMs === null || natural(value.processStartTimeMs)) &&
      (!('runtime' in value) || bounded(value.runtime)) &&
      Object.keys(value).every((key) =>
        ['hostId', 'pid', 'processStartTimeMs', 'runtime'].includes(key)
      ))
  )
}

function isJournalBoundary(value: unknown): value is AgentJournalCursor | null {
  return (
    value === null ||
    (typeof value === 'object' &&
      'epoch' in value &&
      bounded(value.epoch) &&
      'sequence' in value &&
      natural(value.sequence))
  )
}

export function isReadableAgentSessionClosedOwner(
  key: string,
  value: unknown
): value is AgentSessionClosedOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'sessionId' in value &&
    isAgentSessionId(value.sessionId) &&
    'location' in value &&
    isAgentSessionExecutionLocation(value.location) &&
    'deadOwnerFence' in value &&
    natural(value.deadOwnerFence) &&
    'evidence' in value &&
    isAgentSessionDeathEvidence(value.evidence) &&
    value.evidence.ownerFence === value.deadOwnerFence &&
    'process' in value &&
    isClosedOwnerProcess(value.process) &&
    'journalBoundary' in value &&
    isJournalBoundary(value.journalBoundary) &&
    key ===
      agentSessionClosedOwnerKey({
        sessionId: value.sessionId,
        location: value.location,
        deadOwnerFence: value.deadOwnerFence
      })
  )
}

/**
 * Recovery retains ownership until present-time evidence proves exit. Transport loss cannot
 * prove exit. Native POSIX owners may be stopped by verified identity; Windows owners and
 * terminal agents are only released on exit proof, since their saved pid is not a safe stop handle.
 */

import {
  isProvenAliveProbe,
  isProvenDeadProbe,
  type AgentSessionOwnerProbe
} from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type StructuredSessionRecoveryStopSignal = 'SIGTERM' | 'SIGKILL'

export type StructuredSessionRecoveryResolutionDeps = {
  store: AgentSessionRecordStore
  probeRecord: (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe>
  now: () => number
  stopOwnerProcess?: (pid: number, signal: StructuredSessionRecoveryStopSignal) => void
  delay?: (ms: number) => Promise<void>
  platform?: NodeJS.Platform
}

const STOP_PROBE_INTERVAL_MS = 250
// POSIX only: Windows never signals a recorded owner. The owner is its provider supervisor, which
// exits only after its provider group. A SIGKILL that lands first leaves the group running, so
// SIGTERM outlasts its stop.
const STOP_PROBES: Record<StructuredSessionRecoveryStopSignal, number> = {
  SIGTERM: Math.ceil(PROVIDER_SUPERVISOR_MAX_STOP_MS / STOP_PROBE_INTERVAL_MS) + 1,
  SIGKILL: 4
}

const UNRESOLVED_REFUSALS: ReadonlySet<string> = new Set([
  'agent_session_ownership_unknown',
  'agent_session_checkpoint_stale',
  'execution_owner_reconciling',
  'agent_session_identity_required'
])

export async function resolveStructuredSessionRecovery(
  deps: StructuredSessionRecoveryResolutionDeps,
  sessionId: string
): Promise<'resolved' | 'unresolved' | 'not-applicable'> {
  const record = deps.store.getRecord(sessionId)
  if (record?.lease.handoffStage !== 'recovering') {
    return 'not-applicable'
  }
  let probe = await deps.probeRecord(record)
  const owner = record.lease.ownerProcess
  if (owner && record.lease.claimStatus === 'conflicted' && !isProvenDeadProbe(probe)) {
    // A terminal agent keeps its transport across a restart, so only proof of its exit is a way in.
    return 'unresolved'
  }
  if (owner && isProvenAliveProbe(probe)) {
    if (owner.hostId !== deps.store.hostId) {
      return 'unresolved'
    }
    if ((deps.platform ?? process.platform) !== 'win32') {
      probe = await stopOwnerAndReprobe(deps, record, owner.pid)
    }
  }
  const alreadyFree =
    record.lease.claimStatus === 'released' && record.lease.reservedSpawnToken === null
  if (owner ? !isProvenDeadProbe(probe) : !alreadyFree && probe.outcome !== 'reservation-unused') {
    return 'unresolved'
  }
  try {
    await deps.store.evictProvenDeadOwner({
      sessionId,
      expectedFence: record.lease.runtimeFence,
      probe,
      now: deps.now()
    })
    return 'resolved'
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error)
    if (UNRESOLVED_REFUSALS.has(code)) {
      // The record moved under this resolution; the next attempt re-asks against what it is now.
      return 'unresolved'
    }
    throw error
  }
}

async function stopOwnerAndReprobe(
  deps: StructuredSessionRecoveryResolutionDeps,
  record: AgentSessionRecord,
  pid: number
): Promise<AgentSessionOwnerProbe> {
  const stop = deps.stopOwnerProcess ?? defaultStopOwnerProcess
  const delay = deps.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let probe: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'owner stop requested' }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    stop(pid, signal)
    for (let attempt = 0; attempt < STOP_PROBES[signal]; attempt += 1) {
      probe = await deps.probeRecord(record)
      if (isProvenDeadProbe(probe)) {
        return probe
      }
      await delay(STOP_PROBE_INTERVAL_MS)
    }
  }
  return probe
}

function defaultStopOwnerProcess(pid: number, signal: StructuredSessionRecoveryStopSignal): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone or not ours to signal; the next probe supplies the actual proof.
  }
}

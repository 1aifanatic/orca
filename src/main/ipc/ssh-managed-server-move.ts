/**
 * The user's "Move to managed server": stop the host's relay terminals, prove them exited with the
 * connect gate's own census, then reconnect so the connect-time decision runs the conversion.
 */
import { getAppEnvironment } from '../../shared/app-environment'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import type { SshManagedServerMoveResult } from '../../shared/ssh-managed-server-move'
import type {
  SshManagedServerStatus,
  SshTarget,
  SshTerminateSessionsResult
} from '../../shared/ssh-types'
import type { HostServerTerminalVerdict } from '../ssh/ssh-host-server-on-connect'
import { getSshHostServerStatus } from '../ssh/ssh-host-server-status'
import {
  trackSshHostServerMove,
  type SshHostServerMoveOutcome
} from '../ssh/ssh-host-server-telemetry'
import { knownSshHostPlatform } from '../ssh/ssh-host-platform-memo'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { connectTarget } from './ssh-connect-flow'
import { publishRelayTerminalsStatus } from './ssh-host-server-connect'
import { teardownSshTargetTransport } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { terminateSshTargetSessions } from './ssh-terminate-sessions'

export type SshManagedServerMoveDeps = {
  getTarget: (targetId: string) => SshTarget | undefined
  terminate: (targetId: string) => Promise<SshTerminateSessionsResult>
  relayTerminals: (target: SshTarget) => Promise<HostServerTerminalVerdict>
  connect: (targetId: string) => Promise<unknown>
  serverStatus: (targetId: string) => SshManagedServerStatus | undefined
  report: (targetId: string, outcome: SshHostServerMoveOutcome) => void
  /** Closes a relay session whose terminals the census proved exited. */
  releaseRelay: (targetId: string) => Promise<void>
  /** Replaces a stale relay-terminals status after a move that stopped short. */
  publishRelayStatus: (
    target: SshTarget,
    census: { verdict: 'live' | 'unverifiable'; count: number }
  ) => void
}

export async function moveSshHostToManagedServer(
  targetId: string,
  deps: SshManagedServerMoveDeps = defaultMoveDeps()
): Promise<SshManagedServerMoveResult> {
  let result: SshManagedServerMoveResult | null = null
  try {
    result = await moveHost(targetId, deps)
    return result
  } finally {
    deps.report(targetId, moveOutcome(result))
  }
}

function moveOutcome(result: SshManagedServerMoveResult | null): SshHostServerMoveOutcome {
  if (!result) {
    return 'failed'
  }
  return result.outcome === 'refused' ? `refused_${result.verdict}` : result.outcome
}

async function moveHost(
  targetId: string,
  deps: SshManagedServerMoveDeps
): Promise<SshManagedServerMoveResult> {
  const target = deps.getTarget(targetId)
  if (!target) {
    throw new Error(`SSH target "${targetId}" not found`)
  }
  // Why the census decides, not the stop: a stop can fail after its shells died (a relay that
  // hung up on its last exit), and the census is what the conversion itself trusts.
  const stopped = await stopRelayTerminals(targetId, deps).catch((error: unknown) => {
    console.warn('[ssh] Stopping relay terminals for the move failed; asking the census:', error)
    return null
  })
  const current = deps.getTarget(targetId) ?? target
  const census: HostServerTerminalVerdict =
    stopped && stopped.unverifiable > 0
      ? // Why: an unreached shell is never evidence that it exited (ssh-execution-boundary.md).
        { verdict: 'unverifiable', count: stopped.unverifiable }
      : await deps.relayTerminals(current)
  if (census.verdict !== 'exited') {
    deps.publishRelayStatus(current, { verdict: census.verdict, count: census.count })
    // The stop closed the relay session; reconnect so the host's workspaces aren't left offline.
    const reconnected = await deps.connect(targetId).then(
      () => deps.serverStatus(targetId),
      (error: unknown) => {
        console.warn('[ssh] Reconnecting after a refused move failed:', error)
        return undefined
      }
    )
    // The reconnect's own gate may have proven the terminals exited since, and converted.
    return reconnected?.kind === 'managed'
      ? { outcome: 'moved', environmentId: reconnected.environmentId }
      : { outcome: 'refused', verdict: census.verdict, terminals: census.count }
  }
  if (!stopped) {
    // The failed stop left the relay up; a live session would make the reconnect a no-op refresh.
    await deps.releaseRelay(targetId)
  }
  await deps.connect(targetId)
  const status = deps.serverStatus(targetId)
  return status?.kind === 'managed'
    ? { outcome: 'moved', environmentId: status.environmentId }
    : { outcome: 'stayed' }
}

/** Mirrors the renderer's terminate: preserved shells need a fresh relay before they can be stopped. */
async function stopRelayTerminals(
  targetId: string,
  deps: SshManagedServerMoveDeps
): Promise<SshTerminateSessionsResult> {
  try {
    return await deps.terminate(targetId)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      throw error
    }
    await deps.connect(targetId)
    return deps.terminate(targetId)
  }
}

function defaultMoveDeps(): SshManagedServerMoveDeps {
  return {
    getTarget: (targetId) => getSshTargetRegistryStore()!.getTarget(targetId),
    terminate: terminateSshTargetSessions,
    relayTerminals: async (target) => {
      // Why lazy, like the connect: the managed-server graph loads only when it is needed.
      const { hostServerOnConnectDeps } = await import('./ssh-host-server-on-connect-wiring')
      return hostServerOnConnectDeps(getAppEnvironment().getPath('userData')).relayTerminals(target)
    },
    connect: connectTarget,
    serverStatus: getSshHostServerStatus,
    report: (targetId, outcome) => trackSshHostServerMove(outcome, knownSshHostPlatform(targetId)),
    publishRelayStatus: publishRelayTerminalsStatus,
    releaseRelay: (targetId) =>
      runTargetLifecycle(targetId, () =>
        teardownSshTargetTransport(targetId, (session) => session.disposeAndPersist())
      )
  }
}

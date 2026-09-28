import {
  sshRemotePtyLeaseAllowsReattach,
  type SshTerminateSessionsResult
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdsForConnection,
  getSshPtyProvider
} from './pty'
import { activeSessions } from './ssh-active-relay-sessions'
import { invalidateConnectAttempt } from './ssh-connect-attempt-registry'
import { connectTarget } from './ssh-connect-flow'
import { isSshTargetDisconnectedByUser } from './ssh-connection-intent'
import { connectionManager, persistedStore } from './ssh-ipc-context'
import { teardownSshTargetTransport } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

/**
 * The user's "end terminals": kills the host's remote sessions, dialing the relay once when they
 * need it. Why one lifecycle operation owning the dial: no caller-held step sits between the dial
 * and its close, and a user Connect made meanwhile waits for it instead of joining the dial.
 */
export async function terminateSshTargetSessions(
  targetId: string
): Promise<SshTerminateSessionsResult> {
  invalidateConnectAttempt(targetId)
  let outcome: SshTerminateSessionsResult = { terminated: 0, unverifiable: 0 }
  await runTargetLifecycle(targetId, async () => {
    let dialedWhileHeldDown = false
    try {
      outcome = await terminateReachableSessions(targetId)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
        throw error
      }
      // Why: disconnect is non-destructive, so preserved remote PTYs need a fresh relay to be killed.
      dialedWhileHeldDown = isSshTargetDisconnectedByUser(targetId)
      await connectTarget(targetId, 'session-cleanup')
      outcome = await terminateReachableSessions(targetId)
    } finally {
      // Why dialedWhileHeldDown too: that dial skipped forwards and phone tabs, so a user Connect
      // made since must dial its own session rather than inherit this one.
      if (dialedWhileHeldDown || isSshTargetDisconnectedByUser(targetId)) {
        await closeCleanupTransport(targetId)
      }
    }
  })
  return outcome
}

// Why no authority rotation: a user Connect parked behind this operation must still run after it.
async function closeCleanupTransport(targetId: string): Promise<void> {
  if (!connectionManager!.getConnection(targetId) && !activeSessions.has(targetId)) {
    return
  }
  try {
    // Why detach: a failed terminate leaves its leases for a retry.
    await teardownSshTargetTransport(targetId, (session) => session.detachAndPersist())
  } catch (error) {
    console.warn(
      `[ssh] Failed to close the session-cleanup transport of ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// Why (#12661): an offline sweep tears down local transport only. The caller must be able to tell
// "the host stopped these" from "nobody asked the host", so the verdict is returned.
async function terminateReachableSessions(targetId: string): Promise<SshTerminateSessionsResult> {
  let outcome: SshTerminateSessionsResult = { terminated: 0, unverifiable: 0 }
  const provider = getSshPtyProvider(targetId)
  const leases = persistedStore!.getSshRemotePtyLeases(targetId)
  const ptyIdsByRelayId = new Map<string, string>()
  // Why: only leases the app still believes it owns may force a reconnect; a lease whose route
  // died for good is swept opportunistically instead, so a target that can no longer answer
  // never blocks its own removal (issue #2626, and the renderer tolerates the refusal there).
  const ownedRelayIds = new Set<string>()
  const trackPtyId = (ptyId: string, owned: boolean): void => {
    const relayPtyId = toRelaySshPtyId(targetId, ptyId)
    if (!ptyIdsByRelayId.has(relayPtyId)) {
      ptyIdsByRelayId.set(relayPtyId, toAppSshPtyId(targetId, ptyId))
    }
    if (owned) {
      ownedRelayIds.add(relayPtyId)
    }
  }
  for (const ptyId of getPtyIdsForConnection(targetId)) {
    trackPtyId(ptyId, true)
  }
  for (const lease of leases) {
    if (lease.state === 'terminated') {
      continue
    }
    // Why the predicate and not `state !== 'expired'`: an `expired` lease carrying no
    // retirement mark records only that reattach gave up, never that the remote shell died, so
    // it is exactly the orphan the user's terminate must reach — and reaching it needs the
    // relay, which is what the fence below demands. Only `supersededBy` / `relayIdRecycled`
    // prove the route is dead for good, and those stay unowned.
    trackPtyId(lease.ptyId, sshRemotePtyLeaseAllowsReattach(lease))
  }
  const ptyIds = Array.from(ptyIdsByRelayId, ([relayPtyId, appPtyId]) => ({
    relayPtyId,
    appPtyId
  }))

  if (ownedRelayIds.size > 0 && !provider) {
    throw new Error(
      `${SSH_TERMINATE_RECONNECT_REQUIRED}: SSH relay is not connected; reconnect before terminating remote sessions.`
    )
  }
  const shutdownResults = provider
    ? await Promise.allSettled(
        ptyIds.map(({ appPtyId }) =>
          provider.shutdown(appPtyId, { immediate: true, keepHistory: false })
        )
      )
    : []
  if (!provider) {
    // Nothing observed these remote shells, so their state is unknown — not "nothing to do".
    outcome = { terminated: 0, unverifiable: ptyIds.length }
  }
  const shutdownFailures: string[] = []
  for (const [index, result] of shutdownResults.entries()) {
    const { appPtyId, relayPtyId } = ptyIds[index]
    if (result.status !== 'fulfilled' && !isSshPtyNotFoundError(result.reason)) {
      shutdownFailures.push(
        `${relayPtyId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      )
      continue
    }
    clearProviderPtyState(appPtyId)
    deletePtyOwnership(appPtyId)
    persistedStore!.markSshRemotePtyLease(targetId, relayPtyId, 'terminated')
    outcome = { ...outcome, terminated: outcome.terminated + 1 }
  }
  if (shutdownFailures.length > 0) {
    // Why: a failed relay shutdown can leave the remote process alive in the grace window; keep the lease/session so the user can retry.
    throw new Error(`Failed to terminate SSH host sessions: ${shutdownFailures.join('; ')}`)
  }
  await teardownSshTargetTransport(targetId, (session) => session.disposeAndPersist())
  return outcome
}

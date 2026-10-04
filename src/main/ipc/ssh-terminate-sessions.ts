import {
  sshRemotePtyLeaseAllowsReattach,
  type SshTerminateSessionsResult
} from '../../shared/ssh-types'
import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../shared/constants'
import { isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import { isReattachHeldByPreviousRelay } from '../ssh/ssh-previous-relay-terminals'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdsForConnection,
  getSshPtyProvider
} from './pty'
import { invalidateConnectAttempt } from './ssh-connect-attempt-registry'
import { persistedStore } from './ssh-ipc-context'
import { teardownSshTargetTransport } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

/** Stops every relay terminal on the target and closes its transport (`ssh:terminateSessions`). */
export async function terminateSshTargetSessions(
  targetId: string
): Promise<SshTerminateSessionsResult> {
  invalidateConnectAttempt(targetId)
  // Why (#12661): an offline sweep tears down local transport only. The caller must be able to tell
  // "the host stopped these" from "nobody asked the host", so carry the verdict out of the lifecycle queue.
  let outcome: SshTerminateSessionsResult = { terminated: 0, unverifiable: 0 }
  await runTargetLifecycle(targetId, async () => {
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
      if (
        result.status !== 'fulfilled' &&
        (await isReattachHeldByPreviousRelay(targetId, result.reason))
      ) {
        // Not found here is not absence while an older build's relay may still run it (#25124).
        outcome = { ...outcome, unverifiable: outcome.unverifiable + 1 }
        continue
      }
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
  })
  return outcome
}

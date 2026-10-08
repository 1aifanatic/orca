import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'

export type SshPtyLeaseTombstoneRetentionOperations = {
  state: PersistedState
}

/** A routing tombstone with nothing left to route: the operator closed this PTY and no stop is
 *  still owed for it. `expired` is deliberately not here — it says only that the CLIENT lost its
 *  route (docs/reference/ssh-execution-boundary.md), and `sweepOrphanedRelayPtys` reads those ids
 *  as its leave-alone list, so deleting one would authorize stopping a remote shell that
 *  supersession left running on purpose. */
function isRetiredRoutingTombstone(lease: SshRemotePtyLease, targetId: string): boolean {
  return (
    lease.targetId === targetId && lease.state === 'terminated' && lease.pendingKill === undefined
  )
}

/**
 * Deletes the `terminated` rows no reader needs, bounding an array that otherwise only grew.
 *
 * The row answers no question any reader asks. Reattach refuses it
 * (`sshRemotePtyLeaseAllowsReattach`), pane recovery matches on `expired` only, the orphan sweep
 * already classes it neither routed nor expired, and `ssh:reset` / `ssh:terminateSessions` skip it
 * outright — every one of those behaves identically on an absent row, whether or not a binding
 * still names the pty. A `pendingKill` is an undelivered stop, so those rows stay until the replay
 * retires them.
 *
 * Does not re-arm the local-worktree-metadata prune gate: a `terminated` lease no longer counts as
 * a persisted workspace owner, so dropping one cannot make any metadata row more removable.
 */
export function pruneRetiredSshRemotePtyLeaseTombstones(
  operations: SshPtyLeaseTombstoneRetentionOperations,
  targetId: string
): boolean {
  const leases = operations.state.sshRemotePtyLeases ?? []
  const retained = leases.filter((lease) => !isRetiredRoutingTombstone(lease, targetId))
  if (retained.length === leases.length) {
    return false
  }
  operations.state.sshRemotePtyLeases = retained
  return true
}

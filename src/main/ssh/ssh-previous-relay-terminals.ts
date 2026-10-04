/**
 * Whether a relay from an earlier Orca build may still run this target's terminals.
 *
 * An app update installs a new relay beside the old one, and the old one refuses this build's
 * handshake, so a PTY it owns answers "not found" from the new relay while it keeps running. That
 * answer is the union "never minted here" — not absence — so while an older relay endpoint for this
 * target is live or unverifiable, a not-found reattach must not retire the lease or respawn the pane
 * (docs/reference/ssh-execution-boundary.md). Asked once per deploy, before reattach can need it.
 */
import { isProvenExitedPtyAttachRefusal } from '../../shared/pty-attach-absence-evidence'
import { isSshPtyIdentityMismatchError, isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import type { SshConnection } from './ssh-connection'
import { execCommand } from './ssh-relay-deploy-helpers'
import { SHORT_RELAY_SOCKET_DIR_PREFIX } from './relay-socket-path-limit'
import {
  isReapableRelayHusk,
  probeRelayEndpointIncumbent,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { supersededRelayEndpointListCommand } from './ssh-relay-superseded-endpoints'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'

export type PreviousRelayCensusInput = {
  hostPlatform?: RemoteHostPlatform
  remoteHome?: string
  remoteRelayDir?: string
  nodePath?: string
  sockPath?: string
}

const MAX_CENSUS_ENDPOINTS = 32
const censusByTarget = new Map<string, Promise<boolean>>()

/** An older relay that holds nothing, or is gone, cannot be running this target's terminals. */
export function mayHoldTerminals(incumbent: RelayEndpointIncumbent): boolean {
  return incumbent.verdict !== 'exited' && !isReapableRelayHusk(incumbent)
}

export async function censusPreviousRelays(
  conn: SshConnection,
  targetId: string,
  input: PreviousRelayCensusInput
): Promise<boolean> {
  const { hostPlatform, remoteHome, remoteRelayDir, nodePath, sockPath } = input
  // Windows pipes are not enumerable (see the superseded sweep), so those hosts keep today's path.
  if (!hostPlatform || isWindowsRemoteHost(hostPlatform) || !remoteHome || !remoteRelayDir) {
    return false
  }
  if (!nodePath) {
    return false
  }
  const listing = await execCommand(
    conn,
    supersededRelayEndpointListCommand({
      remoteHome,
      currentRelayDir: remoteRelayDir,
      sockName: relaySocketNameForInstanceId(targetId),
      ...(sockPath?.startsWith(SHORT_RELAY_SOCKET_DIR_PREFIX)
        ? { currentShortSocketDir: sockPath.slice(0, sockPath.lastIndexOf('/')) }
        : {})
    }),
    { wrapCommand: true }
  )
  const sockPaths = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
    .slice(0, MAX_CENSUS_ENDPOINTS)
  for (const endpoint of sockPaths) {
    const incumbent = await probeRelayEndpointIncumbent(conn, hostPlatform, nodePath, endpoint)
    if (mayHoldTerminals(incumbent)) {
      return true
    }
  }
  return false
}

/** Starts this deploy's census; a newer deploy for the target replaces it. */
export function startPreviousRelayCensus(
  conn: SshConnection,
  targetId: string,
  input: PreviousRelayCensusInput
): void {
  const census = censusPreviousRelays(conn, targetId, input).catch((error: unknown) => {
    // A census that could not run leaves the reattach on today's path, which never kills anything.
    console.warn(
      `[ssh-relay] Previous relay census did not run for ${targetId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return false
  })
  censusByTarget.set(targetId, census)
}

export function previousRelayMayHoldTerminals(targetId: string): Promise<boolean> {
  return censusByTarget.get(targetId) ?? Promise.resolve(false)
}

export function clearPreviousRelayCensus(targetId: string): void {
  censusByTarget.delete(targetId)
}

/** A not-found reattach this target must keep, because an older build's relay may run the PTY. */
export async function isReattachHeldByPreviousRelay(
  targetId: string,
  error: unknown
): Promise<boolean> {
  if (
    !isSshPtyNotFoundError(error) ||
    isSshPtyIdentityMismatchError(error) ||
    isProvenExitedPtyAttachRefusal(error)
  ) {
    return false
  }
  return previousRelayMayHoldTerminals(targetId)
}

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
/**
 * `complete` only when every older endpoint on an enumerable host was censused. `unverifiable` when
 * such a host could not be fully censused: a failed run, missing inputs, or too many endpoints.
 */
type PreviousRelayCensus = {
  endpoints: string[]
  nodePath?: string
  complete: boolean
  unverifiable: boolean
}
const censusByTarget = new Map<string, Promise<PreviousRelayCensus>>()
const NO_CENSUS: PreviousRelayCensus = { endpoints: [], complete: false, unverifiable: false }

/** Windows pipes are not enumerable (see the superseded sweep), so those hosts keep today's path. */
function isEnumerableRelayHost(input: PreviousRelayCensusInput): boolean {
  return Boolean(input.hostPlatform && !isWindowsRemoteHost(input.hostPlatform))
}

/** An older relay that holds nothing, or is gone, cannot be running this target's terminals. */
export function mayHoldTerminals(incumbent: RelayEndpointIncumbent): boolean {
  return incumbent.verdict !== 'exited' && !isReapableRelayHusk(incumbent)
}

/** The older endpoints for this target that may still run its terminals. */
export async function censusPreviousRelays(
  conn: SshConnection,
  targetId: string,
  input: PreviousRelayCensusInput
): Promise<string[]> {
  return (await runPreviousRelayCensus(conn, targetId, input))?.endpoints ?? []
}

/** Null when the host is enumerable but an input the census needs is missing. */
async function runPreviousRelayCensus(
  conn: SshConnection,
  targetId: string,
  input: PreviousRelayCensusInput
): Promise<{ endpoints: string[]; truncated: boolean } | null> {
  const { hostPlatform, remoteHome, remoteRelayDir, nodePath, sockPath } = input
  if (!hostPlatform || !isEnumerableRelayHost(input)) {
    return { endpoints: [], truncated: false }
  }
  if (!remoteHome || !remoteRelayDir || !nodePath) {
    return null
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
  const listed = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
  const holding: string[] = []
  for (const endpoint of listed.slice(0, MAX_CENSUS_ENDPOINTS)) {
    const incumbent = await probeRelayEndpointIncumbent(conn, hostPlatform, nodePath, endpoint)
    if (mayHoldTerminals(incumbent)) {
      holding.push(endpoint)
    }
  }
  return { endpoints: holding, truncated: listed.length > MAX_CENSUS_ENDPOINTS }
}

/** Starts this deploy's census; a newer deploy for the target replaces it. */
export function startPreviousRelayCensus(
  conn: SshConnection,
  targetId: string,
  input: PreviousRelayCensusInput
): Promise<PreviousRelayCensus> {
  const census = runPreviousRelayCensus(conn, targetId, input).then(
    (ran): PreviousRelayCensus => {
      const enumerable = isEnumerableRelayHost(input)
      const unverifiable = enumerable && (!ran || ran.truncated)
      return {
        endpoints: ran?.endpoints ?? [],
        nodePath: input.nodePath,
        complete: enumerable && !unverifiable,
        unverifiable
      }
    },
    (error: unknown): PreviousRelayCensus => {
      // Not "no older relay": a census that could not run leaves its terminals unverifiable.
      console.warn(
        `[ssh-relay] Previous relay census did not run for ${targetId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return { endpoints: [], complete: false, unverifiable: true }
    }
  )
  censusByTarget.set(targetId, census)
  return census
}

/** This deploy's census, with the node it ran under, which can also run an older bridge. */
export function previousRelayCensus(targetId: string): Promise<PreviousRelayCensus> {
  return censusByTarget.get(targetId) ?? Promise.resolve(NO_CENSUS)
}

export async function previousRelayMayHoldTerminals(targetId: string): Promise<boolean> {
  const census = await previousRelayCensus(targetId)
  return census.endpoints.length > 0 || census.unverifiable
}

/** A session's teardown passes the census it started, so a newer deploy's census survives it. */
export function clearPreviousRelayCensus(
  targetId: string,
  census?: Promise<PreviousRelayCensus>
): void {
  if (!census || censusByTarget.get(targetId) === census) {
    censusByTarget.delete(targetId)
  }
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

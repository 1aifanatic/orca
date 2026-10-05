/**
 * The connect-time relay census on a Windows host, before any relay session exists.
 *
 * Windows relay endpoints are named pipes with no inode to list, but each version directory's pipe
 * for this target is derived from that directory and the target's socket name. So every version
 * directory, the current one included, is probed the way the previous-relay census probes older
 * ones, and a pipe that may be live is asked through its own bridge for `pty.listProcesses`. A pipe
 * that may be live but cannot be asked is unverifiable: a shell no lease here knows must never let
 * the host convert under it.
 */
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { probeRelayVersionDirLiveness } from './remote-install-gc'
import { RELAY_INSTALL_MODEL, remoteInstallVersionDirRegex } from './remote-install-model'
import type { HostRelayEndpointCensus } from './ssh-host-relay-endpoint-census'
import { countRelayPtysOverBridge } from './ssh-relay-endpoint-pty-count'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import { execCommand } from './ssh-relay-deploy-helpers'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { windowsRelayConnectCommand } from './ssh-relay-windows-launch-command'
import { listRemoteInstallBaseDirsCommand } from './ssh-remote-commands'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { isNodeRuntimeTarget } from '../../shared/node-runtime-pin'
import { orcadNodeRuntimeExecutable } from '../../shared/orcad-artifacts'
import { nodeRuntimeStoreDir, remoteNodeRuntimePresentCommand } from './orcad-remote-node-runtime'
import { REMOTE_NODE_RUNTIME_READY } from './orcad-remote-node-runtime-report'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'

const MAX_CENSUS_VERSION_DIRS = 32

export async function censusWindowsHostRelays(
  conn: SshConnection,
  args: {
    host: RemoteHostPlatform
    remoteHome: string
    targetId: string
    /** Resolved only when a version directory exists; null when the host has no Node to probe with. */
    nodePath: () => Promise<string | null>
    signal?: AbortSignal
  }
): Promise<HostRelayEndpointCensus> {
  const { host, signal } = args
  const baseDir = joinRemotePath(host, args.remoteHome, RELAY_REMOTE_DIR)
  let listing: string
  try {
    listing = await execCommand(
      conn,
      listRemoteInstallBaseDirsCommand(host, baseDir, RELAY_INSTALL_MODEL),
      { wrapCommand: false, signal }
    )
  } catch {
    return { verdict: 'unverifiable', count: 0 }
  }
  const versionDir = remoteInstallVersionDirRegex(RELAY_INSTALL_MODEL)
  const dirs = listing
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => versionDir.test(name))
    .map((name) => joinRemotePath(host, baseDir, name))
  if (dirs.length === 0) {
    return { verdict: 'none', count: 0 }
  }
  const nodePath =
    dirs.length > MAX_CENSUS_VERSION_DIRS ? null : await args.nodePath().catch(() => null)
  if (!nodePath) {
    return { verdict: 'unverifiable', count: dirs.length }
  }
  const sockName = relaySocketNameForInstanceId(args.targetId)
  let live = 0
  let unverifiable = 0
  for (const dir of dirs) {
    const verdict = await probeRelayVersionDirLiveness(conn, dir, host, {
      windowsNodePath: nodePath,
      windowsSockNames: [sockName]
    })
    if (verdict === 'exited') {
      continue
    }
    const counts = await Promise.all(
      windowsRelayPipePathsForSocketName(host, dir, sockName).map((pipe) =>
        countRelayPtysOverBridge(
          conn,
          windowsRelayConnectCommand(
            host,
            nodePath,
            dir,
            pipe,
            joinRemotePath(host, dir, `${sockName}.credential`)
          ),
          signal,
          { wrapCommand: false }
        )
      )
    )
    const answered = counts.filter((count): count is number => count !== null)
    if (answered.some((count) => count > 0)) {
      live += 1
    } else if (answered.length === 0) {
      unverifiable += 1
    }
  }
  if (live > 0) {
    return { verdict: 'live', count: live }
  }
  return unverifiable > 0
    ? { verdict: 'unverifiable', count: unverifiable }
    : { verdict: 'idle', count: 0 }
}

/**
 * The Node a Windows census probes and bridges with: the pinned runtime relays on this host run on,
 * when it is published, else the host's own Node.
 */
export async function windowsCensusNodePath(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  signal?: AbortSignal
): Promise<string | null> {
  const target = `${host.os}-${host.arch}`
  if (isNodeRuntimeTarget(target)) {
    const runtimeDir = nodeRuntimeStoreDir(
      host,
      joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR),
      target
    )
    const present = await execCommand(conn, remoteNodeRuntimePresentCommand(host, runtimeDir), {
      wrapCommand: false,
      signal
    }).catch(() => '')
    if (present.trim() === REMOTE_NODE_RUNTIME_READY) {
      return joinRemotePath(host, runtimeDir, orcadNodeRuntimeExecutable(target))
    }
  }
  return resolveRemoteNodePath(conn, host, { signal }).catch(() => null)
}

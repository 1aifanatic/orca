/**
 * An SSH host and the managed Orca server Orca runs on it are one machine to the user, so host
 * lists show them as one row: the SSH host's name, keyed by whichever route serves it now.
 */
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { ExecutionHostRegistryEntry } from './execution-host-registry'
import type { SshConnectionState } from './ssh-types'

export type ManagedOrcadEnvironmentSummary = {
  id: string
  orcadDeployment?: { sshTargetId: string } | null
}

/** The SSH target this environment is the managed Orca server for; null for any other server. */
export function getManagedOrcadSshTargetId(
  environment: ManagedOrcadEnvironmentSummary
): string | null {
  return environment.orcadDeployment?.sshTargetId.trim() || null
}

/**
 * Collapses each listed SSH host and its managed server into one entry, in place. The server's id
 * survives unless main reports the host on its relay; the other id is kept as an alias for
 * persisted selections, or kept as its own row while workspaces still point at it.
 */
export function mergeManagedOrcadExecutionHosts(args: {
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>
  runtimeEnvironments: readonly ManagedOrcadEnvironmentSummary[]
  sshConnectionStates?: ReadonlyMap<string, Pick<SshConnectionState, 'managedServer'>>
  referencedHostIds: ReadonlySet<ExecutionHostId>
}): void {
  for (const environment of args.runtimeEnvironments) {
    const targetId = getManagedOrcadSshTargetId(environment)
    if (!targetId) {
      continue
    }
    const sshHostId = toSshExecutionHostId(targetId)
    const runtimeHostId = toRuntimeExecutionHostId(environment.id.trim())
    const sshHost = args.hosts.get(sshHostId)
    const runtimeHost = args.hosts.get(runtimeHostId)
    // Why: an orphaned server (its SSH host removed) is the only row left for that machine.
    if (!sshHost || !runtimeHost) {
      continue
    }
    const onRelay = args.sshConnectionStates?.get(targetId)?.managedServer?.kind === 'relay'
    const retiredHostId = onRelay ? runtimeHostId : sshHostId
    const keepRetired = args.referencedHostIds.has(retiredHostId)
    const aliasHostIds = keepRetired ? undefined : [retiredHostId]
    if (onRelay) {
      args.hosts.set(sshHostId, { ...sshHost, ...(aliasHostIds ? { aliasHostIds } : {}) })
    } else {
      // Why the server's id: a managed host has no relay, so only the server can serve it.
      args.hosts.set(runtimeHostId, {
        ...runtimeHost,
        label: sshHost.label,
        detail: sshHost.detail,
        ...(aliasHostIds ? { aliasHostIds } : {})
      })
    }
    if (!keepRetired) {
      args.hosts.delete(retiredHostId)
    }
  }
}

/** Indexes hosts by id and alias, so a selection saved under a merged-away id still resolves. */
export function indexExecutionHostsById<T extends Pick<ExecutionHostRegistryEntry, 'id'>>(
  hosts: readonly (T & { aliasHostIds?: readonly ExecutionHostId[] })[]
): Map<ExecutionHostId, T> {
  const byId = new Map<ExecutionHostId, T>(hosts.map((host) => [host.id, host]))
  for (const host of hosts) {
    for (const aliasHostId of host.aliasHostIds ?? []) {
      if (!byId.has(aliasHostId)) {
        byId.set(aliasHostId, host)
      }
    }
  }
  return byId
}

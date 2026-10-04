/**
 * Recovers a host an earlier build stranded: a conversion fenced it and registered its managed
 * server, but the host's sshd refuses the forward that server is reached by, so nothing was ever
 * staged there. The source still holds every row, so the server is unregistered and the fence
 * released through the undeployed-fence path, and the relay serves the host again.
 */
import { listEnvironments } from '../../shared/runtime-environment-store'
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'
import { releaseUndeployedMigrationFence } from './orcad-migration-source-fence'
import { closeOrcadManagedTunnel } from './orcad-managed-tunnel'
import type { SshTargetOrcadClaims } from './ssh-target-orcad-claims'

export async function releaseUnreachableOrcadSetup(args: {
  userDataPath: string
  claims: SshTargetOrcadClaims
  targetId: string
  signal?: AbortSignal
}): Promise<void> {
  const cutover = findOrcadMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Why only this phase: a staged or committed destination holds state only it can account for.
  if (cutover?.phase !== 'source-fenced') {
    return
  }
  const environmentId = cutover.destinationEnvironmentId
  await closeOrcadManagedTunnel(environmentId).catch(() => undefined)
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  // Unregister first: a crash after it leaves an undeployed fence, which the same path releases.
  if (isRegistered(environmentId)) {
    removeManagedOrcadEnvironment(args.userDataPath, environmentId)
  }
  await releaseUndeployedMigrationFence({
    userDataPath: args.userDataPath,
    claims: args.claims,
    targetId: args.targetId,
    isDestinationRegistered: isRegistered,
    signal: args.signal
  })
}

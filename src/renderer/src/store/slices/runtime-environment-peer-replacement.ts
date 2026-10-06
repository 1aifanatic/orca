import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

type CatalogEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'createdAt' | 'pairingRevision' | 'orcadDeployment' | 'hostKeyFingerprint'
>

/** Ids whose pairing rotated since the previous catalog. */
export function replacedRuntimeEnvironmentIds(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[]
): string[] {
  const previousById = new Map(previous.map((environment) => [environment.id, environment]))
  return next
    .filter((environment) => {
      const before = previousById.get(environment.id)
      return (
        before !== undefined &&
        (before.pairingRevision ?? before.createdAt) !==
          (environment.pairingRevision ?? environment.createdAt)
      )
    })
    .map((environment) => environment.id)
}

/**
 * Re-paired ids that may now name a different machine. A managed server re-pairs on every update;
 * it is the same machine only when the host's key digest, which its pairing handshake proves, is
 * known and unchanged under the same SSH target registration. A registration alone is no proof:
 * a reinstalled host, or a target that now resolves elsewhere, keeps it. Without that evidence
 * the environment is retired, workspaces and tabs included, as before.
 */
export function peerReplacedEnvironmentIds(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[],
  replacedIds: readonly string[]
): string[] {
  return replacedIds.filter((id) => {
    const before = previous.find((environment) => environment.id === id)
    const after = next.find((environment) => environment.id === id)
    const beforeDeployment = before?.orcadDeployment
    const afterDeployment = after?.orcadDeployment
    return !(
      beforeDeployment &&
      afterDeployment &&
      beforeDeployment.sshTargetId === afterDeployment.sshTargetId &&
      beforeDeployment.sshTargetGeneration === afterDeployment.sshTargetGeneration &&
      before.hostKeyFingerprint &&
      before.hostKeyFingerprint === after.hostKeyFingerprint
    )
  })
}

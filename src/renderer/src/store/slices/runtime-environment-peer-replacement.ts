import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

type CatalogEnvironment = Pick<
  PublicKnownRuntimeEnvironment,
  'id' | 'createdAt' | 'pairingRevision' | 'runtimeId' | 'orcadDeployment'
>

/** Ids whose pairing rotated, or whose host proved a different runtime identity. */
export function replacedRuntimeEnvironmentIds(
  previous: readonly CatalogEnvironment[],
  next: readonly CatalogEnvironment[]
): string[] {
  const previousById = new Map(previous.map((environment) => [environment.id, environment]))
  return next
    .filter((environment) => {
      const before = previousById.get(environment.id)
      if (!before) {
        return false
      }
      const rotated =
        (before.pairingRevision ?? before.createdAt) !==
        (environment.pairingRevision ?? environment.createdAt)
      // Why both known: a first recorded runtime id is a verification, not a different host.
      const reidentified =
        Boolean(before.runtimeId) &&
        Boolean(environment.runtimeId) &&
        before.runtimeId !== environment.runtimeId
      return rotated || reidentified
    })
    .map((environment) => environment.id)
}

/**
 * Replaced ids that now name a different machine. A managed server re-pairs on every update; it is
 * still the same machine only when the host's own runtime identity, which the pairing handshake
 * verifies, is known and unchanged under the same SSH target registration. Anything less is
 * treated as a different machine, whose workspaces and tabs are retired.
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
      before.runtimeId &&
      before.runtimeId === after.runtimeId
    )
  })
}

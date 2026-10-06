import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'

type DeployedEnvironment = Pick<PublicKnownRuntimeEnvironment, 'id' | 'orcadDeployment'>

/**
 * Re-paired ids that now name a different peer. A managed server re-pairs on every update but stays
 * the same server (one SSH target registration), so its workspaces and tabs must survive.
 */
export function peerReplacedEnvironmentIds(
  previous: readonly DeployedEnvironment[],
  next: readonly DeployedEnvironment[],
  repairedIds: readonly string[]
): string[] {
  return repairedIds.filter((id) => {
    const before = previous.find((environment) => environment.id === id)?.orcadDeployment
    const after = next.find((environment) => environment.id === id)?.orcadDeployment
    return !(
      before &&
      after &&
      before.sshTargetId === after.sshTargetId &&
      before.sshTargetGeneration === after.sshTargetGeneration
    )
  })
}

/**
 * Retiring a converted host's retained source once source retirement is switched on: every
 * manifest in the host's chain, newest first, and only after its newest move committed.
 *
 * Why newest first, compacting only at the end: a failure part-way leaves a retired head, which
 * resumes, never a retained head whose baseline counts rows already deleted and so reads as changed.
 */
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import {
  listOrcadMigrationCutoverChainForTarget,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { retireOrcadMigrationSource } from './orcad-migration-source-retirement'
import { compareRetainedOrcadSource } from './orcad-retained-source'

export async function retireRetainedOrcadSourceChain(
  userDataPath: string,
  store: Store,
  target: SshTarget,
  runTargetLifecycle: <T>(targetId: string, operation: () => Promise<T>) => Promise<T>
): Promise<'retired' | 'skipped'> {
  const chain = listOrcadMigrationCutoverChainForTarget(userDataPath, target.id)
  const head = chain.at(-1)
  // A delta in flight still needs every row it will move, so nothing retires before it commits.
  if (!head || (head.phase !== 'destination-committed' && head.phase !== 'source-retired')) {
    return 'skipped'
  }
  // Rows an older build changed are a new move, never something to delete.
  if (
    head.phase === 'destination-committed' &&
    !head.sourceRetiringAt &&
    compareRetainedOrcadSource(store, target, head) !== 'unchanged'
  ) {
    return 'skipped'
  }
  const environment =
    listEnvironments(userDataPath).find((entry) => entry.id === head.destinationEnvironmentId) ??
    null
  if (head.phase === 'destination-committed' && !head.sourceRetiringAt) {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...head,
      sourceRetiringAt: new Date().toISOString()
    })
  }
  for (const cutover of chain.toReversed()) {
    await runTargetLifecycle(target.id, () =>
      retireOrcadMigrationSource({ userDataPath, store, environment: null }, cutover.migrationId)
    )
  }
  for (const cutover of chain) {
    await runTargetLifecycle(target.id, () =>
      retireOrcadMigrationSource({ userDataPath, store, environment }, cutover.migrationId)
    )
  }
  return 'retired'
}

/**
 * Retiring a converted host's retained source once source retirement is switched on: every
 * manifest in the host's chain, newest first, and only after its newest move committed.
 *
 * Why newest first, compacting only at the end: a failure part-way leaves a retired head, which
 * resumes, never a retained head whose baseline counts rows already deleted and so reads as changed.
 */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import {
  listOrcadMigrationCutoverChainForTarget,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { retireOrcadMigrationSource } from './orcad-migration-source-retirement'
import { compareRetainedOrcadSource } from './orcad-retained-source'
import { recordOrcadRetirementBaselines } from './orcad-retirement-authorization'

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
  // Every committed cutover needs its journaled baseline before anything is deleted.
  if (
    chain.some(
      (cutover) => cutover.phase === 'destination-committed' && !cutover.sourceRetirementBaseline
    )
  ) {
    // Rows an older build changed are a new move, never something to delete. A start marker with
    // no baseline (an earlier build's) proves nothing, so only an unchanged source may record one.
    if (
      head.phase !== 'destination-committed' ||
      compareRetainedOrcadSource(store, target, head) !== 'unchanged'
    ) {
      if (head.sourceRetiringAt) {
        markLegacyRetirementConflict(userDataPath, head)
      }
      return 'skipped'
    }
    recordOrcadRetirementBaselines(
      userDataPath,
      store,
      chain,
      head.sourceRetiringAt ?? new Date().toISOString()
    )
  }
  const environment =
    listEnvironments(userDataPath).find((entry) => entry.id === head.destinationEnvironmentId) ??
    null
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

function markLegacyRetirementConflict(
  userDataPath: string,
  head: OrcadMigrationSourceCutover
): void {
  if (!head.sourceRetirementConflict) {
    writeOrcadMigrationSourceCutover(userDataPath, {
      ...head,
      sourceRetirementConflict: { at: new Date().toISOString(), paths: ['baseline-missing'] }
    })
  }
}

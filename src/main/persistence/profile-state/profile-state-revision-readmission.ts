import { openProfileStateDatabaseReadOnly } from './profile-state-database'
import { readProfileStateRevisionOperation } from './profile-state-revision'
import { ProfileStateRevisionConflictError } from './profile-state-document-validation'

/**
 * Reopening a live snapshot cannot adopt another writer's intervening revision.
 * A recovery handoff may adopt revision + 1 only when that commit recorded the
 * interrupted request's id: revision arithmetic alone cannot exclude another writer.
 */
export function assertProfileStateRevisionOnDisk(
  databasePath: string,
  profileId: string,
  revision: number,
  interruptedOperation?: string
): number {
  const admitted = openProfileStateDatabaseReadOnly(databasePath, profileId)
  try {
    const actual = readProfileStateRevisionOperation(admitted.db)
    const expected =
      interruptedOperation !== undefined &&
      actual.revision === revision + 1 &&
      actual.operationId === interruptedOperation
        ? actual.revision
        : revision
    if (actual.revision !== expected) {
      throw new ProfileStateRevisionConflictError(expected, actual.revision)
    }
    return expected
  } finally {
    admitted.db.close()
  }
}

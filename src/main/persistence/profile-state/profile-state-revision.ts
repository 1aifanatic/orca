import type Database from '../../sqlite/sync-database'
import {
  PROFILE_STATE_META_LAST_WRITE_OPERATION,
  PROFILE_STATE_META_REVISION
} from './profile-state-database-schema'
import { isRecord, ProfileStateDocumentCorruptionError } from './profile-state-document-validation'

export function readProfileStateRevision(db: Database.Database): number {
  const row = db
    .prepare('SELECT value FROM profile_state_meta WHERE key = ?')
    .get(PROFILE_STATE_META_REVISION)
  return parseProfileStateRevision(
    isRecord(row) && typeof row.value === 'string' ? row.value : undefined
  )
}

function parseProfileStateRevision(value: string | undefined): number {
  if (value === undefined) {
    return 0
  }
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ProfileStateDocumentCorruptionError('Profile state revision is invalid')
  }
  return revision
}

/** Publish a committed revision inside the caller's write transaction. */
export function writeProfileStateRevision(
  db: Database.Database,
  revision: number,
  operationId?: string
): void {
  const upsert = db.prepare(
    `INSERT INTO profile_state_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  upsert.run(PROFILE_STATE_META_REVISION, String(revision))
  if (operationId !== undefined) {
    upsert.run(PROFILE_STATE_META_LAST_WRITE_OPERATION, operationId)
  }
}

/** One statement, so the revision and operation id come from the same commit. */
export function readProfileStateRevisionOperation(db: Database.Database): {
  revision: number
  operationId: string | undefined
} {
  let revision: string | undefined
  let operationId: string | undefined
  for (const row of db
    .prepare('SELECT key, value FROM profile_state_meta WHERE key IN (?, ?)')
    .all(PROFILE_STATE_META_REVISION, PROFILE_STATE_META_LAST_WRITE_OPERATION)) {
    if (isRecord(row) && typeof row.value === 'string') {
      if (row.key === PROFILE_STATE_META_REVISION) {
        revision = row.value
      } else {
        operationId = row.value
      }
    }
  }
  return { revision: parseProfileStateRevision(revision), operationId }
}

/** Unchanged domains may lag the profile revision, but cannot lead it. */
export function assertProfileStateDocumentRevision(
  revision: number,
  profileRevision: number,
  domain: string
): void {
  if (revision > profileRevision) {
    throw new ProfileStateDocumentCorruptionError(
      `Profile state document revision ${revision} exceeds profile revision ${profileRevision}`,
      domain
    )
  }
}

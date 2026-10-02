import { tableExists } from '../../opencode-usage/schema-helpers'
import {
  isRecord,
  keyFromCredentialRecord,
  OPENCODE_GO_INTEGRATION_ID
} from '../../rate-limits/opencode-go-credential-record'
import SyncDatabase from '../../sqlite/sync-database'
import type { OpenCodeGoKeyReadResult } from '../opencode-go-key-result'

function selectCredentialKey(database: SyncDatabase): string | null {
  if (!tableExists(database, 'credential')) {
    return null
  }
  // OpenCode marks the chosen credential per integration with `active = 1`;
  // newest wins among the rest (packages/core/src/credential.ts).
  const rows: unknown[] = database
    .prepare(
      'SELECT value FROM credential WHERE integration_id = ? ' +
        'ORDER BY active DESC, time_created DESC LIMIT 8'
    )
    .all(OPENCODE_GO_INTEGRATION_ID)
  for (const row of rows) {
    if (!isRecord(row) || typeof row.value !== 'string') {
      continue
    }
    try {
      const key = keyFromCredentialRecord(JSON.parse(row.value), 'key')
      if (key) {
        return key
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Read the `opencode-go` key from OpenCode's `credential` table; runs only on the
 * foreign SQLite reader worker, since opencode.db can carry a large -wal.
 * @param dbPaths - Databases in probe order; the first one holding a key wins.
 * @returns The key; `missing` when none holds one; `unreadable` when none had a key
 * but at least one failed to open or query.
 */
export function readOpenCodeGoKey(dbPaths: readonly string[]): OpenCodeGoKeyReadResult {
  let sawUnreadable = false
  for (const path of dbPaths) {
    let database: SyncDatabase | null = null
    try {
      database = new SyncDatabase(path, { readonly: true, fileMustExist: true })
      database.pragma('query_only = ON')
      const key = selectCredentialKey(database)
      if (key) {
        return { status: 'found', key }
      }
    } catch {
      // A locked, WAL-index-less, or foreign-schema database may still hold the
      // key; a later database can still supply one.
      sawUnreadable = true
    } finally {
      database?.close()
    }
  }
  return { status: sawUnreadable ? 'unreadable' : 'missing' }
}

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import SyncDatabase from '../../sqlite/sync-database'
import type {
  CodexIndexStatusResult,
  CodexStateDbBackfillStatus
} from '../codex-index-status-result'
import type { CodexIndexStatusQuery } from '../foreign-sqlite-reader-protocol'

// Why a reader: Codex's state DB can carry a large -wal, and a Codex home can sit on
// a \\wsl.localhost share whose readdir or open hangs, so none of this runs on the main thread.

const STATE_DB_FILE_PATTERN = /^state_(\d+)\.sqlite$/
const statusRowSchema = z.object({ status: z.unknown() }).partial().optional()

export function findNewestCodexStateDbPath(codexHomePath: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(codexHomePath)
  } catch {
    return null
  }
  let newest: { version: number; name: string } | null = null
  for (const name of entries) {
    const match = STATE_DB_FILE_PATTERN.exec(name)
    if (!match) {
      continue
    }
    const version = Number(match[1])
    if (!newest || version > newest.version) {
      newest = { version, name }
    }
  }
  return newest ? join(codexHomePath, newest.name) : null
}

function closeQuietly(db: SyncDatabase | null): void {
  try {
    db?.close()
  } catch {
    // A close failure cannot change the read-only result already collected.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reads Codex-owned backfill metadata without creating or mutating its database. */
export function readCodexStateDbBackfillStatus(codexHomePath: string): CodexStateDbBackfillStatus {
  const stateDbPath = findNewestCodexStateDbPath(codexHomePath)
  if (!stateDbPath) {
    return { kind: 'missing' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backfill_state'")
      .get()
    if (!table) {
      return { kind: 'not-tracked', stateDbPath }
    }
    const row = statusRowSchema.parse(
      db.prepare('SELECT status FROM backfill_state WHERE id = 1').get()
    )
    if (!row || typeof row.status !== 'string') {
      return { kind: 'not-tracked', stateDbPath }
    }
    return row.status === 'complete'
      ? { kind: 'complete', stateDbPath }
      : { kind: 'incomplete', stateDbPath, status: row.status }
  } catch (error) {
    return { kind: 'unreadable', stateDbPath, error: errorText(error) }
  } finally {
    closeQuietly(db)
  }
}

/** Lower-cased thread ids in Codex's state DB; null ids when it is missing or unreadable. */
function readIndexedCodexThreadIds(
  codexHomePath: string
): Extract<CodexIndexStatusResult, { type: 'indexedThreadIds' }> {
  const stateDbPath = findNewestCodexStateDbPath(codexHomePath)
  if (!stateDbPath) {
    return { type: 'indexedThreadIds', threadIds: null, error: null }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, { readonly: true, fileMustExist: true })
    const ids = new Set<string>()
    for (const row of db.prepare('SELECT id FROM threads').all()) {
      if (typeof row.id === 'string') {
        ids.add(row.id.toLowerCase())
      }
    }
    return { type: 'indexedThreadIds', threadIds: [...ids], error: null }
  } catch (error) {
    return { type: 'indexedThreadIds', threadIds: null, error: errorText(error) }
  } finally {
    closeQuietly(db)
  }
}

export function countCodexSessionFilesUpTo(sessionsRoot: string, limit: number): number {
  let count = 0
  const pendingDirectories = [sessionsRoot]
  while (pendingDirectories.length > 0 && count < limit) {
    const directory = pendingDirectories.pop()
    if (directory === undefined) {
      break
    }
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pendingDirectories.push(join(directory, entry.name))
      } else if (
        entry.isFile() &&
        // Why: Codex's startup backfill parses compressed rollouts too.
        (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))
      ) {
        count += 1
        if (count >= limit) {
          break
        }
      }
    }
  }
  return count
}

/**
 * Answer one Codex index question; runs only on the foreign SQLite reader worker.
 * @param query - Which home or sessions tree to read, and what to read from it.
 */
export function readCodexIndexStatus(query: CodexIndexStatusQuery): CodexIndexStatusResult {
  if (query.type === 'indexedThreadIds') {
    return readIndexedCodexThreadIds(query.codexHomePath)
  }
  if (query.type === 'sessionFileCount') {
    return {
      type: 'sessionFileCount',
      count: countCodexSessionFilesUpTo(query.sessionsRoot, query.limit)
    }
  }
  const status = readCodexStateDbBackfillStatus(query.codexHomePath)
  // Rollouts decide only for a home with no backfill row; skip the walk otherwise.
  const sessionFileCount =
    status.kind === 'missing' || status.kind === 'not-tracked'
      ? countCodexSessionFilesUpTo(join(query.codexHomePath, 'sessions'), query.sessionFileLimit)
      : null
  return { type: 'backfill', status, sessionFileCount }
}

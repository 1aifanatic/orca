import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { currentWorkerEntryLayout } from '../worker-thread-entry-path'
import type { CursorDesktopProfileReadResult } from './cursor-profile-result'
import {
  ForeignSqliteReaderClient,
  type CodexIndexStatusAnswer
} from './foreign-sqlite-reader-client'
import { resolveForeignSqliteReaderEntryPath } from './foreign-sqlite-reader-entry-path'
import type { CodexIndexStatusQuery } from './foreign-sqlite-reader-protocol'
import type { BinderSessionRow, OpenCodeSessionCursor } from './opencode-binder-sessions-result'
import type { OpenCodeGoKeyReadResult } from './opencode-go-key-result'

// Why: owns the process-wide client and the real worker factory, so the client
// class stays testable with a fake factory and callers see only plain functions.

function defaultWorkerFactory(): Worker {
  const workerPath = resolveForeignSqliteReaderEntryPath(currentWorkerEntryLayout(__dirname))
  // A missing entry (e.g. a host whose build omits it) throws here so reads fail closed.
  if (!existsSync(workerPath)) {
    throw new Error(`Foreign SQLite reader entry not found: ${workerPath}`)
  }
  return new Worker(workerPath)
}

let sharedClient: ForeignSqliteReaderClient | null = null
let workerFactory: WorkerThreadFactory = defaultWorkerFactory

function getSharedClient(): ForeignSqliteReaderClient {
  sharedClient ??= new ForeignSqliteReaderClient({ workerFactory })
  return sharedClient
}

/**
 * Read the Cursor IDE's stored session on the foreign SQLite reader worker.
 * @param dbPath - Cursor's state.vscdb.
 * @returns `missing`, `ok`, or `error` (also when the worker cannot answer).
 */
export function readCursorDesktopProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
  return getSharedClient().readCursorProfile(dbPath)
}

/**
 * List OpenCode 1 sessions newer than `cursor` on the foreign SQLite reader worker.
 * @param dbPath - The shared server's opencode.db.
 * @param cursor - Store position the binder has handled up to.
 * @returns Rows oldest first; `[]` when the store or the worker cannot answer.
 */
export function readOpenCodeBinderSessions(
  dbPath: string,
  cursor: OpenCodeSessionCursor
): Promise<BinderSessionRow[]> {
  return getSharedClient().readOpenCodeBinderSessions(dbPath, cursor)
}

/**
 * Read OpenCode's stored Go key on the foreign SQLite reader worker.
 * @param dbPaths - Credential databases in probe order.
 * @returns `found`, `missing`, or `unreadable` (also when the worker cannot answer).
 */
export function readOpenCodeGoKeyFromDatabases(
  dbPaths: readonly string[]
): Promise<OpenCodeGoKeyReadResult> {
  return getSharedClient().readOpenCodeGoKey(dbPaths)
}

/**
 * Answer a Codex index question on the foreign SQLite reader worker.
 * @param query - The home or sessions tree to read, and what to read.
 * @returns The answer, or null when the worker cannot answer.
 */
export function readCodexIndexStatus<Q extends CodexIndexStatusQuery>(
  query: Q
): Promise<CodexIndexStatusAnswer<Q> | null> {
  return getSharedClient().readCodexIndexStatus(query)
}

export const _internals = {
  /** Swap the worker factory (null restores the built entry) and drop the live client. */
  setWorkerFactory(factory: WorkerThreadFactory | null): void {
    sharedClient?.dispose()
    sharedClient = null
    workerFactory = factory ?? defaultWorkerFactory
  }
}

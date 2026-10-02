import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import {
  parseCodexIndexStatusResult,
  type CodexIndexStatusResult
} from './codex-index-status-result'
import {
  cursorProfileReadFailure,
  parseCursorProfileReadResult,
  type CursorDesktopProfileReadResult
} from './cursor-profile-result'
import {
  hermesSessionRowsFailure,
  hermesSessionRunsFailure,
  parseHermesSessionRows,
  parseHermesSessionRuns,
  type HermesSessionRow,
  type HermesSessionRunRows
} from './hermes-session-runs-result'
import {
  openCodeBinderSessionsFailure,
  parseOpenCodeBinderSessions,
  type BinderSessionRow,
  type OpenCodeSessionCursor
} from './opencode-binder-sessions-result'
import type {
  CodexIndexStatusQuery,
  ForeignSqliteReaderKind,
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'
import {
  openCodeGoKeyReadFailure,
  parseOpenCodeGoKeyReadResult,
  type OpenCodeGoKeyReadResult
} from './opencode-go-key-result'

// Why: an open of another app's database can block for seconds on a large -wal,
// so it never runs on the main thread. Each reader gets its own lazily started
// thread (all from one factory) so a slow database delays only its own reader.

const READ_TIMEOUT_MS = 60_000
// Why per reader: a thread torn down between a poller's rounds is respawned every round.
const DEFAULT_IDLE_TEARDOWN_MS: Record<ForeignSqliteReaderKind, number> = {
  cursorProfile: 30_000,
  // The OpenCode binder polls every 60 s.
  openCodeBinderSessions: 120_000,
  openCodeGoKey: 30_000,
  codexIndexStatus: 30_000,
  hermesSessionRunRefs: 30_000,
  hermesSessionRuns: 30_000
}
const MAX_CONSECUTIVE_DEATHS = 3
const KEEP_ALIVE_INTERVAL_MS = 60_000

type LaneSettings = {
  workerFactory: WorkerThreadFactory
  log: (message: string) => void
  timeoutMs: number
  idleTeardownMs: number
}

/** One reader's thread plus its in-flight reads, keyed by what they read. */
export class ForeignSqliteReaderLane<T> {
  private readonly queue: WorkerThreadRequestQueue<
    ForeignSqliteReaderRequest,
    ForeignSqliteReaderResponse
  >
  private readonly inFlight = new Map<string, Promise<T | null>>()

  constructor(
    private readonly kind: ForeignSqliteReaderKind,
    private readonly parse: (value: unknown) => T | null,
    private readonly settings: LaneSettings
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory: settings.workerFactory,
      idleTeardownMs: settings.idleTeardownMs,
      maxConsecutiveDeaths: MAX_CONSECUTIVE_DEATHS,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `Foreign SQLite reader ${kind} timed out after ${ms}ms`,
      describeExit: (code) => `Foreign SQLite reader ${kind} exited with code ${code}`,
      describeCrashLoop: (lastError) =>
        `Foreign SQLite reader ${kind} crashed repeatedly (${lastError})`,
      onUnavailable: (err) =>
        settings.log(`Foreign SQLite reader ${kind} worker unavailable: ${errorText(err)}`)
    })
  }

  /**
   * Read on this reader's thread.
   * @param key - What is read (e.g. the database path); concurrent reads of it share one request.
   * @param buildRequest - Builds the request around the queue's correlation id.
   * @returns The parsed value, or null when the worker did not answer (timeout, crash,
   * no worker, error or malformed reply); callers map null to their failure value.
   */
  read(key: string, buildRequest: (id: number) => ForeignSqliteReaderRequest): Promise<T | null> {
    const pending = this.inFlight.get(key)
    if (pending) {
      return pending
    }
    // Why: the worker and its timeout timer are unref'd, so a short-lived process such
    // as the CLI would exit mid-read; this ref'd handle lives until the read settles.
    const keepAlive = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS)
    const read = this.dispatch(buildRequest).finally(() => {
      clearInterval(keepAlive)
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, read)
    return read
  }

  dispose(): void {
    this.queue.dispose()
    this.inFlight.clear()
  }

  private async dispatch(
    buildRequest: (id: number) => ForeignSqliteReaderRequest
  ): Promise<T | null> {
    const { kind, settings } = this
    try {
      const response = await this.queue.dispatch(buildRequest, settings.timeoutMs)
      if (!response.ok) {
        settings.log(`Foreign SQLite reader ${kind} failed: ${response.error}`)
        return null
      }
      const value = this.parse(response.value)
      if (value === null) {
        settings.log(`Foreign SQLite reader ${kind} returned a malformed result.`)
      }
      return value
    } catch (err) {
      // Timeout, crash, or no worker: never retried on the main thread.
      settings.log(`Foreign SQLite reader ${kind} did not answer: ${errorText(err)}`)
      return null
    }
  }
}

export class ForeignSqliteReaderClient {
  private readonly cursorProfile: ForeignSqliteReaderLane<CursorDesktopProfileReadResult>
  private readonly openCodeBinderSessions: ForeignSqliteReaderLane<BinderSessionRow[]>
  private readonly openCodeGoKey: ForeignSqliteReaderLane<OpenCodeGoKeyReadResult>
  private readonly codexIndexStatus: ForeignSqliteReaderLane<CodexIndexStatusResult>
  private readonly hermesSessionRunRefs: ForeignSqliteReaderLane<HermesSessionRow[]>
  private readonly hermesSessionRuns: ForeignSqliteReaderLane<HermesSessionRunRows[]>

  constructor(options: {
    workerFactory: WorkerThreadFactory
    log?: (message: string) => void
    timeoutMs?: number
    idleTeardownMs?: Partial<Record<ForeignSqliteReaderKind, number>>
  }) {
    const settings = (kind: ForeignSqliteReaderKind): LaneSettings => ({
      workerFactory: options.workerFactory,
      log: options.log ?? ((message: string) => console.warn(message)),
      timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
      idleTeardownMs: options.idleTeardownMs?.[kind] ?? DEFAULT_IDLE_TEARDOWN_MS[kind]
    })
    this.cursorProfile = new ForeignSqliteReaderLane(
      'cursorProfile',
      parseCursorProfileReadResult,
      settings('cursorProfile')
    )
    this.openCodeBinderSessions = new ForeignSqliteReaderLane(
      'openCodeBinderSessions',
      parseOpenCodeBinderSessions,
      settings('openCodeBinderSessions')
    )
    this.openCodeGoKey = new ForeignSqliteReaderLane(
      'openCodeGoKey',
      parseOpenCodeGoKeyReadResult,
      settings('openCodeGoKey')
    )
    this.codexIndexStatus = new ForeignSqliteReaderLane(
      'codexIndexStatus',
      parseCodexIndexStatusResult,
      settings('codexIndexStatus')
    )
    this.hermesSessionRunRefs = new ForeignSqliteReaderLane(
      'hermesSessionRunRefs',
      parseHermesSessionRows,
      settings('hermesSessionRunRefs')
    )
    this.hermesSessionRuns = new ForeignSqliteReaderLane(
      'hermesSessionRuns',
      parseHermesSessionRuns,
      settings('hermesSessionRuns')
    )
  }

  /**
   * Read the Cursor IDE's stored session off the main thread.
   * @param dbPath - Cursor's state.vscdb.
   * @returns The reader's result; its failure value when the worker cannot answer.
   */
  async readCursorProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
    const result = await this.cursorProfile.read(dbPath, (id) => ({
      id,
      kind: 'cursorProfile',
      dbPath
    }))
    return result ?? cursorProfileReadFailure()
  }

  /**
   * Read OpenCode's stored Go key off the main thread.
   * @param dbPaths - Credential databases in probe order.
   * @returns The reader's result; `unreadable` when the worker cannot answer.
   */
  async readOpenCodeGoKey(dbPaths: readonly string[]): Promise<OpenCodeGoKeyReadResult> {
    const paths = [...dbPaths]
    const result = await this.openCodeGoKey.read(JSON.stringify(paths), (id) => ({
      id,
      kind: 'openCodeGoKey',
      dbPaths: paths
    }))
    return result ?? openCodeGoKeyReadFailure()
  }

  /**
   * Answer a Codex index question off the main thread.
   * @param query - The home or sessions tree to read, and what to read.
   * @returns The answer, or null when the worker did not answer; callers pick the failure value.
   */
  async readCodexIndexStatus<Q extends CodexIndexStatusQuery>(
    query: Q
  ): Promise<CodexIndexStatusAnswer<Q> | null> {
    const result = await this.codexIndexStatus.read(JSON.stringify(query), (id) => ({
      id,
      kind: 'codexIndexStatus',
      query
    }))
    return result && answersQuery(result, query) ? result : null
  }

  /**
   * List OpenCode 1 sessions newer than `cursor` off the main thread.
   * @param dbPath - The shared server's opencode.db.
   * @param cursor - Store position the binder has handled up to.
   * @returns Rows oldest first; `[]` when the store or the worker cannot answer.
   */
  async readOpenCodeBinderSessions(
    dbPath: string,
    cursor: OpenCodeSessionCursor
  ): Promise<BinderSessionRow[]> {
    // Why the cursor in the key: a round from before a stop can still be in flight
    // with an older cursor, and its rows are not the answer for a restarted round.
    const key = JSON.stringify([dbPath, cursor.ms, cursor.id])
    const result = await this.openCodeBinderSessions.read(key, (id) => ({
      id,
      kind: 'openCodeBinderSessions',
      dbPath,
      cursor: { ms: cursor.ms, id: cursor.id }
    }))
    return result ?? openCodeBinderSessionsFailure()
  }

  /**
   * List one Hermes cron job's session rows off the main thread.
   * @param dbPath - Hermes's state.db.
   * @param jobId - Hermes cron job id.
   * @returns Raw rows newest first; `[]` when state.db or the worker cannot answer.
   */
  async readHermesSessionRunRefRows(dbPath: string, jobId: string): Promise<HermesSessionRow[]> {
    const result = await this.hermesSessionRunRefs.read(JSON.stringify([dbPath, jobId]), (id) => ({
      id,
      kind: 'hermesSessionRunRefs',
      dbPath,
      jobId
    }))
    return result ?? hermesSessionRowsFailure()
  }

  /**
   * Read a page of Hermes runs in one request, so state.db opens once.
   * @param dbPath - Hermes's state.db.
   * @param runIds - Session ids of the page's runs.
   * @returns The runs found; `[]` when state.db or the worker cannot answer.
   */
  async readHermesSessionRuns(
    dbPath: string,
    runIds: readonly string[]
  ): Promise<HermesSessionRunRows[]> {
    const result = await this.hermesSessionRuns.read(JSON.stringify([dbPath, ...runIds]), (id) => ({
      id,
      kind: 'hermesSessionRuns',
      dbPath,
      runIds: [...runIds]
    }))
    return result ?? hermesSessionRunsFailure()
  }

  dispose(): void {
    this.cursorProfile.dispose()
    this.openCodeBinderSessions.dispose()
    this.openCodeGoKey.dispose()
    this.codexIndexStatus.dispose()
    this.hermesSessionRunRefs.dispose()
    this.hermesSessionRuns.dispose()
  }
}

export type CodexIndexStatusAnswer<Q extends CodexIndexStatusQuery> = Extract<
  CodexIndexStatusResult,
  { type: Q['type'] }
>

function answersQuery<Q extends CodexIndexStatusQuery>(
  result: CodexIndexStatusResult,
  query: Q
): result is CodexIndexStatusAnswer<Q> {
  return result.type === query.type
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

import type { WorkerThreadFactory } from '../lazy-worker-thread-host'
import { WorkerThreadRequestQueue } from '../worker-thread-request-queue'
import {
  cursorProfileReadFailure,
  parseCursorProfileReadResult,
  type CursorDesktopProfileReadResult
} from './cursor-profile-result'
import type {
  ForeignSqliteReaderKind,
  ForeignSqliteReaderRequest,
  ForeignSqliteReaderResponse
} from './foreign-sqlite-reader-protocol'

// Why: an open of another app's database can block for seconds on a large -wal,
// so it never runs on the main thread. Each reader gets its own lazily started
// thread (all from one factory) so a slow database delays only its own reader.

const READ_TIMEOUT_MS = 60_000
const IDLE_TEARDOWN_MS = 30_000
const MAX_CONSECUTIVE_DEATHS = 3

type LaneSettings = {
  workerFactory: WorkerThreadFactory
  log: (message: string) => void
  timeoutMs: number
  idleTeardownMs: number
}

/** One reader's thread plus its in-flight reads, keyed by database path. */
export class ForeignSqliteReaderLane<T> {
  private readonly queue: WorkerThreadRequestQueue<
    ForeignSqliteReaderRequest,
    ForeignSqliteReaderResponse
  >
  private readonly inFlight = new Map<string, Promise<T>>()

  constructor(
    private readonly kind: ForeignSqliteReaderKind,
    private readonly parse: (value: unknown) => T | null,
    private readonly failure: () => T,
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
   * Read one database on this reader's thread.
   * @param path - Database path; concurrent reads of it share one request.
   * @param buildRequest - Builds the request around the queue's correlation id.
   * @returns The parsed value, or the reader's failure value if the worker cannot answer.
   */
  read(path: string, buildRequest: (id: number) => ForeignSqliteReaderRequest): Promise<T> {
    const pending = this.inFlight.get(path)
    if (pending) {
      return pending
    }
    const read = this.dispatch(buildRequest).finally(() => {
      this.inFlight.delete(path)
    })
    this.inFlight.set(path, read)
    return read
  }

  dispose(): void {
    this.queue.dispose()
    this.inFlight.clear()
  }

  private async dispatch(buildRequest: (id: number) => ForeignSqliteReaderRequest): Promise<T> {
    const { kind, settings } = this
    try {
      const response = await this.queue.dispatch(buildRequest, settings.timeoutMs)
      if (!response.ok) {
        settings.log(`Foreign SQLite reader ${kind} failed: ${response.error}`)
        return this.failure()
      }
      const value = this.parse(response.value)
      if (value === null) {
        settings.log(`Foreign SQLite reader ${kind} returned a malformed result.`)
        return this.failure()
      }
      return value
    } catch (err) {
      // Timeout, crash, or no worker: never retried on the main thread.
      settings.log(`Foreign SQLite reader ${kind} did not answer: ${errorText(err)}`)
      return this.failure()
    }
  }
}

export class ForeignSqliteReaderClient {
  private readonly cursorProfile: ForeignSqliteReaderLane<CursorDesktopProfileReadResult>

  constructor(options: {
    workerFactory: WorkerThreadFactory
    log?: (message: string) => void
    timeoutMs?: number
    idleTeardownMs?: number
  }) {
    const settings: LaneSettings = {
      workerFactory: options.workerFactory,
      log: options.log ?? ((message: string) => console.warn(message)),
      timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
      idleTeardownMs: options.idleTeardownMs ?? IDLE_TEARDOWN_MS
    }
    this.cursorProfile = new ForeignSqliteReaderLane(
      'cursorProfile',
      parseCursorProfileReadResult,
      cursorProfileReadFailure,
      settings
    )
  }

  /**
   * Read the Cursor IDE's stored session off the main thread.
   * @param dbPath - Cursor's state.vscdb.
   * @returns The reader's result; its failure value when the worker cannot answer.
   */
  readCursorProfile(dbPath: string): Promise<CursorDesktopProfileReadResult> {
    return this.cursorProfile.read(dbPath, (id) => ({ id, kind: 'cursorProfile', dbPath }))
  }

  dispose(): void {
    this.cursorProfile.dispose()
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

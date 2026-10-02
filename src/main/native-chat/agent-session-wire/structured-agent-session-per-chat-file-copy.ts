// Copying every chat still in its old per-chat file into the host's one journal database, in the
// background, so no later launch reads an old file and every chat's status is stored.
//
// A chat is copied on its first use too; this job does the rest after startup. Its shape is the
// common one for background maintenance: a fixed interval starts a run, a run still going skips the
// next tick, a yield ends every task, and a failure is logged, never thrown: one chat's skips that
// chat, and any other ends the job for this launch. One pace holds every task the job runs to a
// share of the main thread (structured-agent-session-per-chat-file-copy-pace.ts). A run waits while
// startup chat work is in flight (startup restoration not yet settled, a tab listing, a history
// restore, the settle step), re-derived before every run and every chat. What is owed is derived
// from the files on disk, so nothing stored can disagree with it
// (structured-agent-session-per-chat-file-queue.ts). A file whose copy failed for good is skipped
// while it and the app version stay as they were (journal-background-failures.ts). A chat too big
// for the free space is left for a later launch; below a floor no chat copies until space returns.
// Each chat copies inside its host serialize, so a send to it goes first or waits for the rest of
// that copy, never for the pace; any other chat waits one batch. Then, under the same pace and
// gate, every chat already in the database gets the status row the version 5 migration left it
// without (structured-agent-session-status-backfill-step.ts).

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  classifyJournalBackgroundFailure,
  forgetJournalBackgroundFailure,
  perChatFileCopyFailureStands,
  recordPerChatFileCopyFailure
} from '../agent-session-journal/journal-background-failures'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { isPerSessionJournalSetAside } from '../agent-session-journal/journal-per-session-reimport'
import {
  statPerChatFile,
  type PerChatFileState
} from '../agent-session-journal/journal-per-session-source'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import {
  createStructuredAgentSessionStatusBackfill,
  settleWrittenChat
} from './structured-agent-session-status-backfill-step'
import { StructuredAgentSessionPerChatFileCopyPace } from './structured-agent-session-per-chat-file-copy-pace'
import { StructuredAgentSessionPerChatFileQueue } from './structured-agent-session-per-chat-file-queue'
import {
  removeEmptyPerChatDirectories,
  roomToCopy
} from './structured-agent-session-per-chat-file-walk'
import type { StructuredAgentSessionChatLocks } from './structured-agent-session-task-queue'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type {
  StructuredAgentSessionStartupState,
  StructuredAgentSessionStartupStateDeps
} from './structured-agent-session-startup-state'

export const PER_CHAT_FILE_COPY_INTERVAL_MS = 1_000
/** No run before this long after the job starts, so the first launch's paint goes first; the first
 *  listing goes first by the startup chat work gate. */
export const PER_CHAT_FILE_COPY_START_DELAY_MS = 10_000
/** After a run stopped for low disk, the next free-space probe waits this long. */
export const PER_CHAT_FILE_COPY_DISK_RETRY_MS = 60_000

export type PerChatFileCopyDeps = {
  database: JournalHostDatabase
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  /** The chats with a tab, in tab order: copied first. */
  listedIds: readonly string[]
  /** Startup chat work is in flight: startup restoration not yet settled, a tab listing, a history
   *  restore, or the settle step. */
  isStartupChatWorkActive: () => boolean
  /** Each chat's lock, and who waits for it: the copy gives way to them inside a chat. */
  tasks: StructuredAgentSessionChatLocks
  /** The chat's journal, when it is open on this host. */
  openJournal: (
    sessionId: string
  ) => Pick<AgentSessionJournal, 'importPending' | 'whenImported'> | undefined
  /** The startup state's one closed-chat settle, which refuses a chat `canSettle` rejects. */
  settleClosedChat: StructuredAgentSessionStartupState['settleClosedChat']
  /** Whether this host settles a chat: the missing-row phase writes no row for one it doesn't. */
  canSettle: StructuredAgentSessionStartupStateDeps['canSettle']
  isDisposed: () => boolean
  logger: StructuredAgentSessionLogger
  now: () => number
  appVersion: string
  /** Free bytes on the state directory's volume; null when unknown. */
  freeBytes?: (directory: string) => Promise<number | null>
  importJournal?: typeof importPerSessionJournal
  /** The copy's share of the main thread; a test supplies its own clock. */
  pace?: StructuredAgentSessionPerChatFileCopyPace
  intervalMs?: number
  startDelayMs?: number
}

type TallyKey =
  | 'copied'
  | 'backfilled'
  | 'deleted'
  | 'setAside'
  | 'failed'
  | 'skipped'
  | 'noRoom'
  | 'orphans'
  | 'leftovers'

export class StructuredAgentSessionPerChatFileCopy {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private finished = false
  private readonly startedAt: number
  private diskRetryAt = 0
  private readonly queue: StructuredAgentSessionPerChatFileQueue
  private readonly logged = new Set<string>()
  private readonly tally = new Map<TallyKey, number>()
  private readonly backfill: ReturnType<typeof createStructuredAgentSessionStatusBackfill>
  private readonly pace: StructuredAgentSessionPerChatFileCopyPace

  constructor(private readonly deps: PerChatFileCopyDeps) {
    this.startedAt = deps.now()
    this.pace = deps.pace ?? new StructuredAgentSessionPerChatFileCopyPace()
    this.queue = new StructuredAgentSessionPerChatFileQueue({
      ...deps,
      onLeftover: () => this.count('leftovers'),
      onOrphan: () => this.count('orphans')
    })
    this.backfill = createStructuredAgentSessionStatusBackfill({ ...deps, inChat: this.inChat })
  }

  start(): void {
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? PER_CHAT_FILE_COPY_INTERVAL_MS
    )
    // A background copy must never be the reason a process stays alive at quit.
    this.timer.unref?.()
  }

  /** Quit: no run starts again, and the one in flight ends at its next batch (the caller aborts
   *  the database's imports first). */
  async stop(): Promise<void> {
    this.finished = true
    this.clearTimer()
    this.pace.stop()
    await this.running?.catch(() => undefined)
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** One run, when every gate is open. A run still going skips it. */
  async tick(): Promise<void> {
    if (this.running || this.finished || this.stopped()) {
      return
    }
    const now = this.deps.now()
    if (
      now - this.startedAt < (this.deps.startDelayMs ?? PER_CHAT_FILE_COPY_START_DELAY_MS) ||
      now < this.diskRetryAt ||
      this.deps.isStartupChatWorkActive()
    ) {
      return
    }
    this.running = this.run()
      .catch((error: unknown) => this.endForLaunch(error))
      .finally(() => {
        this.running = null
      })
    await this.running
  }

  /** Chats until the end, the gate or the disk stops it; the pace alone sets how fast. */
  private async run(): Promise<void> {
    this.pace.begin()
    for (;;) {
      // Re-derived per chat: a listing that starts mid-run pauses the job after the chat in hand.
      if (this.stopped() || this.deps.isStartupChatWorkActive()) {
        return
      }
      const record = await this.queue.next()
      // Old files first, then chats already in the database that have no status row.
      const step = record ? await this.copyChat(record) : await this.backfill.next()
      if (step === 'done') {
        await this.finish()
        return
      }
      if (step === 'stop') {
        return
      }
      if (step === 'backfilled') {
        this.count(step)
      }
      await this.pace.yieldTask()
    }
  }

  private async copyChat(record: AgentSessionRecord): Promise<'copied' | 'skipped' | 'stop'> {
    const { sessionId } = record
    const legacyDirectory = this.deps.database.legacyDirectoryFor({
      workspaceId: record.location.workspaceId,
      sessionId
    })
    try {
      const file = this.fileOwedCopy(sessionId, legacyDirectory)
      if (!file) {
        return 'skipped'
      }
      this.pace.pause()
      const room = await roomToCopy(this.deps.database.stateDirectory, file, this.deps.freeBytes)
      if (room === 'wait') {
        this.queue.defer(record)
        this.diskRetryAt = this.deps.now() + PER_CHAT_FILE_COPY_DISK_RETRY_MS
        return 'stop'
      }
      if (room === 'skip') {
        this.count('noRoom')
        return 'skipped'
      }
      await this.inChat(sessionId, (yieldTask) =>
        this.copyUnderSerialize(record, legacyDirectory, yieldTask)
      )
      return 'copied'
    } catch (error) {
      return this.onFailure(record, legacyDirectory, error)
    }
  }

  /** The chat's file, when the job owes it a copy. */
  private fileOwedCopy(sessionId: string, legacyDirectory: string): PerChatFileState | null {
    const db = this.deps.database.db
    const file = statPerChatFile(legacyDirectory)
    if (!file) {
      forgetJournalBackgroundFailure(db, { sessionId, step: 'copy' })
      return null
    }
    if (isPerSessionJournalSetAside(db, sessionId)) {
      this.count('setAside')
      return null
    }
    if (perChatFileCopyFailureStands(db, { sessionId, file, appVersion: this.deps.appVersion })) {
      this.count('skipped')
      return null
    }
    return file
  }

  private inChat = <T>(
    sessionId: string,
    task: (yieldTask: () => Promise<void>) => Promise<T>
  ): Promise<T> => this.pace.inChat(this.deps.tasks, sessionId, task)

  private async copyUnderSerialize(
    record: AgentSessionRecord,
    legacyDirectory: string,
    yieldTask: () => Promise<void>
  ): Promise<void> {
    if (this.stopped()) {
      return
    }
    const { sessionId } = record
    const open = this.deps.openJournal(sessionId)
    if (open?.importPending) {
      // Previewed by a restore: the copy is that chat's own owed import, run in its write queue
      // and paced like any other.
      await open.whenImported({ yieldTask })
      this.count('copied')
      return
    }
    // The identity an open builds, from the record.
    const identity = journalIdentityFor(
      record,
      attachParamsForRecord(record, {
        clientOperationId: `per-chat-file-copy:${sessionId}`,
        expectedRuntimeFence: record.lease.runtimeFence
      })
    )
    const result = await (this.deps.importJournal ?? importPerSessionJournal)({
      database: this.deps.database,
      identity,
      legacyDirectory,
      yieldTask
    })
    if (result.outcome === 'imported') {
      this.count('copied')
    } else if (result.outcome === 'kept') {
      this.count('setAside')
    } else {
      this.count('deleted')
    }
    // An older build left it with work: settled now, from the copy's fold, so no later startup
    // opens it. A failed settle is not a failed copy: startup settles the row the copy wrote.
    const { load, status } = result
    if (!open && load && status) {
      await settleWrittenChat(this.deps, sessionId, { load, status })
    }
  }

  private onFailure(
    record: AgentSessionRecord,
    legacyDirectory: string,
    error: unknown
  ): 'skipped' | 'stop' {
    const { sessionId } = record
    const kind = classifyJournalBackgroundFailure(error)
    if (kind === 'aborted') {
      return 'stop'
    }
    this.count('failed')
    if (kind === 'transient') {
      this.queue.retry(record)
    } else {
      recordPerChatFileCopyFailure(this.deps.database.db, {
        sessionId,
        legacyDirectory,
        appVersion: this.deps.appVersion,
        error,
        failedAt: this.deps.now()
      })
    }
    if (!this.logged.has(`${sessionId}:${kind}`)) {
      this.logged.add(`${sessionId}:${kind}`)
      this.deps.logger.warn(`copying an old chat file failed (${kind})`, {
        scope: 'per-chat-file-copy',
        sessionId,
        error
      })
    }
    return 'skipped'
  }

  /** A failure outside any one chat's: logged, and the job ends for this launch. The next launch
   *  derives what is still owed. */
  private endForLaunch(error: unknown): void {
    this.finished = true
    this.clearTimer()
    this.deps.logger.warn('copying old chat files stopped for this launch', {
      scope: 'per-chat-file-copy',
      tally: Object.fromEntries(this.tally),
      error
    })
  }

  private async finish(): Promise<void> {
    this.finished = true
    this.clearTimer()
    await removeEmptyPerChatDirectories(this.deps.database.stateDirectory)
    // A summary, not a failure: the host's logger reports only failures.
    console.info('[structured-agent-session] old chat files copied', Object.fromEntries(this.tally))
  }

  private count(key: TallyKey): void {
    this.tally.set(key, (this.tally.get(key) ?? 0) + 1)
  }

  private stopped(): boolean {
    return this.deps.isDisposed() || this.deps.database.importsAborted
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

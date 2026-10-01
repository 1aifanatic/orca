// Copying every chat still in its old per-chat file into the host's one journal database, in the
// background, so no later launch reads an old file and every chat's status is stored.
//
// A chat is copied on its first use too; this job does the rest after startup. Its shape is the
// common one for background maintenance: a fixed interval, a fixed budget per run checked before
// each chat, a yield between chats, a run still going skips the next tick, and a failure is logged,
// never thrown. A run waits while startup chat work is in flight (a tab listing, a history restore,
// the settle step), re-derived before every run and every chat. What is owed is derived from the
// files on disk, so nothing stored can disagree with it: listed chats first, in tab order, then a
// walk of the old-file root. A file whose copy failed for good is skipped while it and the app
// version stay as they were (journal-copy-failures.ts). Each chat copies inside its host serialize,
// so a send to it goes first or waits for the rest of that copy; any other chat waits one batch.
// Then, under the same budget and gate, every chat already in the database gets the status row the
// version 5 migration left it without (structured-agent-session-status-backfill-step.ts).

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  classifyJournalCopyFailure,
  forgetJournalCopyFailure,
  journalCopyFailureStands,
  recordJournalCopyFailure,
  statPerChatFile
} from '../agent-session-journal/journal-copy-failures'
import type { JournalHostDatabase } from '../agent-session-journal/journal-host-database'
import type { JournalLoad } from '../agent-session-journal/journal-open'
import { isUnsettledJournalSessionStatus } from '../agent-session-journal/journal-session-state'
import { importPerSessionJournal } from '../agent-session-journal/journal-per-session-import'
import { isPerSessionJournalSetAside } from '../agent-session-journal/journal-per-session-reimport'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { journalIdentityFor } from './structured-agent-session-attach'
import { attachParamsForRecord } from './structured-agent-session-conversation-open'
import { createStructuredAgentSessionStatusBackfill } from './structured-agent-session-status-backfill-step'
import {
  hasRoomToCopy,
  removeEmptyPerChatDirectories,
  walkPerChatFiles
} from './structured-agent-session-per-chat-file-walk'

export const PER_CHAT_FILE_COPY_INTERVAL_MS = 1_000
/** No run before this long after host startup: the first launch's paint and listing go first. */
export const PER_CHAT_FILE_COPY_START_DELAY_MS = 10_000
export const PER_CHAT_FILE_COPY_RUN_BUDGET_MS = 200
export const PER_CHAT_FILE_COPY_RUN_MAX_CHATS = 8
/** After a run stopped for low disk, the next free-space probe waits this long. */
export const PER_CHAT_FILE_COPY_DISK_RETRY_MS = 60_000
const MAX_TRANSIENT_TRIES = 3

export type PerChatFileCopyDeps = {
  database: JournalHostDatabase
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  /** The chats with a tab, in tab order: copied first. */
  listedIds: readonly string[]
  /** Startup chat work is in flight: a tab listing, a history restore, or the settle step. */
  isStartupChatWorkActive: () => boolean
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The chat's journal, when it is open on this host. */
  openJournal: (
    sessionId: string
  ) => Pick<AgentSessionJournal, 'importPending' | 'whenImported'> | undefined
  /** Settles a copied chat nobody has open, from the copy's load. Inside the chat's serialize. */
  settleCopied: (record: AgentSessionRecord, loaded: JournalLoad) => Promise<void>
  isDisposed: () => boolean
  now: () => number
  appVersion: string
  /** Free bytes on the state directory's volume; null when unknown. */
  freeBytes?: (directory: string) => Promise<number | null>
  importJournal?: typeof importPerSessionJournal
  intervalMs?: number
  startDelayMs?: number
  runBudgetMs?: number
  runMaxChats?: number
}

type TallyKey =
  | 'copied'
  | 'backfilled'
  | 'deleted'
  | 'setAside'
  | 'failed'
  | 'skipped'
  | 'orphans'
  | 'leftovers'

export class StructuredAgentSessionPerChatFileCopy {
  private timer: ReturnType<typeof setInterval> | null = null
  private running: Promise<void> | null = null
  private finished = false
  private readonly startedAt: number
  private diskRetryAt = 0
  private readonly listed: string[]
  private readonly walk: AsyncGenerator<string>
  private recordsByDirectory: Map<string, AgentSessionRecord> | null = null
  private readonly visited = new Set<string>()
  /** Chats a transient failure put back, tried again after the walk. */
  private readonly retries: AgentSessionRecord[] = []
  private readonly tries = new Map<string, number>()
  /** A chat the disk guard turned back, first in line for the next run. */
  private deferred: AgentSessionRecord | null = null
  private readonly logged = new Set<string>()
  private readonly tally = new Map<TallyKey, number>()
  private readonly backfill: ReturnType<typeof createStructuredAgentSessionStatusBackfill>

  constructor(private readonly deps: PerChatFileCopyDeps) {
    this.startedAt = deps.now()
    this.listed = [...deps.listedIds]
    this.backfill = createStructuredAgentSessionStatusBackfill(deps)
    this.walk = walkPerChatFiles(deps.database.stateDirectory, () => this.count('leftovers'))
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
    this.running = this.run().finally(() => {
      this.running = null
    })
    await this.running
  }

  private async run(): Promise<void> {
    const began = this.deps.now()
    const budgetMs = this.deps.runBudgetMs ?? PER_CHAT_FILE_COPY_RUN_BUDGET_MS
    const maxChats = this.deps.runMaxChats ?? PER_CHAT_FILE_COPY_RUN_MAX_CHATS
    let copies = 0
    while (copies < maxChats && this.deps.now() - began < budgetMs) {
      // Re-derived per chat: a listing that starts mid-run pauses the job after the chat in hand.
      if (this.stopped() || this.deps.isStartupChatWorkActive()) {
        return
      }
      const record = this.deferred ?? (await this.nextRecord())
      this.deferred = null
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
      if (step === 'copied' || step === 'backfilled') {
        copies += 1
      }
      await yieldToEventLoop()
    }
  }

  /** The next chat owed a look: listed ones first, then the walk, then transient retries. */
  private async nextRecord(): Promise<AgentSessionRecord | null> {
    for (let id = this.listed.shift(); id !== undefined; id = this.listed.shift()) {
      const record = this.deps.store.getRecord(id)
      if (record && !this.visited.has(id)) {
        return record
      }
    }
    for (let next = await this.walk.next(); !next.done; next = await this.walk.next()) {
      const record = this.recordForDirectory(next.value)
      if (!record) {
        // A deleted chat, or a directory an older build's recovery wrote: never opened or deleted.
        this.count('orphans')
      } else if (!this.visited.has(record.sessionId)) {
        return record
      }
    }
    return this.retries.shift() ?? null
  }

  private async copyChat(record: AgentSessionRecord): Promise<'copied' | 'skipped' | 'stop'> {
    const { sessionId } = record
    const db = this.deps.database.db
    const legacyDirectory = this.deps.database.legacyDirectoryFor({
      workspaceId: record.location.workspaceId,
      sessionId
    })
    const file = statPerChatFile(legacyDirectory)
    this.visited.add(sessionId)
    if (!file) {
      forgetJournalCopyFailure(db, sessionId)
      return 'skipped'
    }
    if (isPerSessionJournalSetAside(db, sessionId)) {
      this.count('setAside')
      return 'skipped'
    }
    if (journalCopyFailureStands(db, sessionId, file, this.deps.appVersion)) {
      this.count('skipped')
      return 'skipped'
    }
    if (!(await hasRoomToCopy(this.deps.database.stateDirectory, file, this.deps.freeBytes))) {
      this.visited.delete(sessionId)
      this.deferred = record
      this.diskRetryAt = this.deps.now() + PER_CHAT_FILE_COPY_DISK_RETRY_MS
      return 'stop'
    }
    try {
      await this.deps.serialize(sessionId, () => this.copyUnderSerialize(record, legacyDirectory))
      return 'copied'
    } catch (error) {
      return this.onFailure(record, legacyDirectory, error)
    }
  }

  private async copyUnderSerialize(
    record: AgentSessionRecord,
    legacyDirectory: string
  ): Promise<void> {
    if (this.stopped()) {
      return
    }
    const { sessionId } = record
    const open = this.deps.openJournal(sessionId)
    if (open?.importPending) {
      // Previewed by a restore: the copy is that chat's own owed import, run in its write queue.
      await open.whenImported()
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
      legacyDirectory
    })
    if (result.outcome === 'imported') {
      this.count('copied')
    } else if (result.outcome === 'kept') {
      this.count('setAside')
    } else {
      this.count('deleted')
    }
    // An older build left it with work: settled now, from the copy's fold, by the same rule the
    // startup settle selects by, so no later startup opens it. A newer build's rows stay unwritten.
    const { load, status } = result
    if (!open && load && status && !load.readOnly && isUnsettledJournalSessionStatus(status)) {
      await this.deps.settleCopied(this.deps.store.getRecord(sessionId) ?? record, load)
    }
  }

  private onFailure(
    record: AgentSessionRecord,
    legacyDirectory: string,
    error: unknown
  ): 'skipped' | 'stop' {
    const { sessionId } = record
    const kind = classifyJournalCopyFailure(error)
    if (kind === 'aborted') {
      return 'stop'
    }
    this.count('failed')
    if (kind === 'transient') {
      const tries = (this.tries.get(sessionId) ?? 0) + 1
      this.tries.set(sessionId, tries)
      if (tries < MAX_TRANSIENT_TRIES) {
        this.retries.push(record)
      }
    } else {
      recordJournalCopyFailure(this.deps.database.db, {
        sessionId,
        legacyDirectory,
        appVersion: this.deps.appVersion,
        error,
        failedAt: this.deps.now()
      })
    }
    if (!this.logged.has(`${sessionId}:${kind}`)) {
      this.logged.add(`${sessionId}:${kind}`)
      console.warn(`[structured-agent-session] copying an old chat file failed (${kind})`, {
        sessionId,
        error
      })
    }
    return 'skipped'
  }

  private recordForDirectory(directory: string): AgentSessionRecord | null {
    // Built on the first file found, so a walk that finds none never hashes a record.
    this.recordsByDirectory ??= new Map(
      this.deps.store.listRecords().map((record) => [
        this.deps.database.legacyDirectoryFor({
          workspaceId: record.location.workspaceId,
          sessionId: record.sessionId
        }),
        record
      ])
    )
    return this.recordsByDirectory.get(directory) ?? null
  }

  private async finish(): Promise<void> {
    this.finished = true
    this.clearTimer()
    await removeEmptyPerChatDirectories(this.deps.database.stateDirectory)
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

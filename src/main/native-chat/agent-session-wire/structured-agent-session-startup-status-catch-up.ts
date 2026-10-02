// The first launch after the upgrade to stored status: listed chats with history here and no status
// row get their rows from their rows alone, before the tab listing answers. The seed that follows
// then publishes them, and the settle takes any a gone process left with work, as on every launch.
// Listed chats whose history is still in a per-chat file are restored now too, by the restart
// restore's own open, which settles and publishes them; the restore after the listing skips them.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  foldJournalSessionStatus,
  writeJournalSessionStatuses,
  type FoldedJournalSessionStatus
} from '../agent-session-journal/journal-session-status-backfill'
import {
  readJournalSessionStatuses,
  type StoredJournalSessionStatus
} from '../agent-session-journal/journal-session-state'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { hasHistoryOutsideJournalDatabase } from './structured-agent-session-read-restore'
import type { StructuredAgentSessionStartupStateDeps } from './structured-agent-session-startup-state'

// Rows per transaction: one commit per chat rewrites the same table and index pages each time.
const WRITE_BATCH_CHATS = 16
// Work per main-process task before yielding, so window IPC and the hook server keep answering.
const TASK_BUDGET_MS = 16

/**
 * Folds and writes the row of every listed chat that has history here and none yet. Answers the
 * listed chats' stored statuses, the written ones included, for the seed to publish without reading
 * them again, or null when it read nothing (a read-only database, quit, or a failure, which it
 * reports). Rows that changed meanwhile belong to chats opened meanwhile, which the seed skips.
 * Never rejects: the seed, the settle and the listing go on whatever happens here.
 */
export async function catchUpMissingStatuses(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[],
  /** The startup settle's one budgeted recovery pass; answers the leases it left unverified. */
  recover: () => Promise<ReadonlySet<string>>
): Promise<StoredJournalSessionStatus[] | null> {
  const database = deps.openDeps.journalDatabase
  if (database.readOnly) {
    return null
  }
  try {
    const stored = readJournalSessionStatuses(database.db, listedIds)
    const missing = stored.flatMap(({ sessionId, status }) => (status ? [] : [sessionId]))
    const inFiles = listedInPerChatFiles(deps, listedIds, stored)
    // Every listed chat has its row: no fold, no yield, no transaction, no open.
    if (missing.length === 0 && inFiles.length === 0) {
      return stored
    }
    const written = missing.length > 0 ? await foldAndWrite(deps, missing) : new Map()
    if (!written) {
      return null
    }
    await restoreFromPerChatFiles(deps, inFiles, recover)
    return stored.map((row) => {
      const status = written.get(row.sessionId)
      return status ? { ...row, status } : row
    })
  } catch (error) {
    deps.openDeps.logger.warn('deriving missing chat statuses at startup failed', {
      scope: 'startup-status-catch-up',
      error
    })
    return null
  }
}

/** The written chats' statuses by id, or null after quit, which stops a fold within one part and
 *  writes nothing more. */
async function foldAndWrite(
  deps: StructuredAgentSessionStartupStateDeps,
  sessionIds: readonly string[]
): Promise<Map<string, FoldedJournalSessionStatus['status']> | null> {
  const quit = new AbortController()
  let taskStart = performance.now()
  const yieldWhenDue = async (): Promise<void> => {
    if (performance.now() - taskStart < TASK_BUDGET_MS) {
      return
    }
    await yieldToEventLoop()
    taskStart = performance.now()
    if (deps.isDisposed()) {
      quit.abort()
    }
  }
  const written = new Map<string, FoldedJournalSessionStatus['status']>()
  let batch: FoldedJournalSessionStatus[] = []
  const flush = (): void => {
    for (const folded of writeBatch(deps, batch)) {
      written.set(folded.sessionId, folded.status)
    }
    batch = []
  }
  for (const sessionId of sessionIds) {
    await yieldWhenDue()
    if (quit.signal.aborted || deps.isDisposed()) {
      return null
    }
    const record = deps.openDeps.store.getRecord(sessionId)
    if (!record || !deps.canSettle(record) || deps.hasSession(sessionId)) {
      continue
    }
    const folded = await foldOne(deps, sessionId, {
      yieldTask: yieldWhenDue,
      signal: quit.signal
    })
    // A corrupt history gets no row, so every launch opens it until its open rebuilds it.
    if (folded && !folded.load.corrupt) {
      batch.push(folded)
    }
    if (batch.length >= WRITE_BATCH_CHATS) {
      flush()
    }
  }
  if (quit.signal.aborted || deps.isDisposed()) {
    return null
  }
  flush()
  return written
}

async function foldOne(
  deps: StructuredAgentSessionStartupStateDeps,
  sessionId: string,
  options: { yieldTask: () => Promise<void>; signal: AbortSignal }
): Promise<FoldedJournalSessionStatus | null> {
  try {
    return await foldJournalSessionStatus(deps.openDeps.journalDatabase, sessionId, options)
  } catch (error) {
    deps.openDeps.logger.warn('deriving a chat status from its rows failed', {
      scope: 'startup-status-catch-up',
      sessionId,
      error
    })
    return null
  }
}

/** One transaction; a chat that moved or got a row since its fold is skipped and left rowless. */
function writeBatch(
  deps: StructuredAgentSessionStartupStateDeps,
  batch: FoldedJournalSessionStatus[]
): FoldedJournalSessionStatus[] {
  try {
    return writeJournalSessionStatuses(deps.openDeps.journalDatabase, batch)
  } catch (error) {
    deps.openDeps.logger.warn('writing chat statuses derived from their rows failed', {
      scope: 'startup-status-catch-up',
      error
    })
    return []
  }
}

/** Listed chats with no epoch here whose history is still in a per-chat file. */
function listedInPerChatFiles(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[],
  stored: readonly StoredJournalSessionStatus[]
): AgentSessionRecord[] {
  const inDatabase = new Set(stored.map(({ sessionId }) => sessionId))
  return listedIds.flatMap((sessionId) => {
    const record = inDatabase.has(sessionId) ? null : deps.openDeps.store.getRecord(sessionId)
    return record &&
      deps.canSettle(record) &&
      !deps.hasSession(sessionId) &&
      hasHistoryOutsideJournalDatabase(deps.openDeps.journalDatabase, record)
      ? [record]
      : []
  })
}

/**
 * Their restore, now rather than after the listing: the restart restore's per-chat worker opens
 * each one from its file, settles what a gone process left and publishes its status, one at a time,
 * a failed chat costing only itself. A lease whose recovery outlasted its budget is not recovered
 * again beside it; its chat opens unverified, as in the settle.
 */
async function restoreFromPerChatFiles(
  deps: StructuredAgentSessionStartupStateDeps,
  records: AgentSessionRecord[],
  recover: () => Promise<ReadonlySet<string>>
): Promise<void> {
  if (records.length === 0 || deps.isDisposed()) {
    return
  }
  try {
    const outlasted = await recover()
    await deps.restoreListed(records, (sessionId) =>
      outlasted.has(sessionId) ? Promise.resolve(true) : deps.resolveRecovery(sessionId)
    )
  } catch (error) {
    deps.openDeps.logger.warn('restoring chats still in per-chat files at startup failed', {
      scope: 'startup-status-catch-up',
      error
    })
  }
}

// What host startup does with each chat's stored status, before any client lists a tab.
//
// Leases: one phase checks them, then starts recovering every lease a crash left `recovering` (a
// surviving provider process is stopped and its death recorded), so each settle verdict below reads
// that evidence; every startup restore answers its lease bookkeeping from that phase.
// Seed: every settled chat still listed and not open has its status row published from its stored
// status, so session lists have it at paint, without opening the chat. A listed chat with no current
// row (last written before stored status, by other rules, or by an older build), or whose history is
// still in a per-chat file, is left to the background restore after the listing, which opens it.
// Settle: once every recovery has ended, every chat whose stored status shows work a gone process
// left, listed or not, is opened once, one at a time, and its open appends the settlement plan. A
// listed one goes through the restart restore's own per-chat worker and stays open; any other is
// settled and closed, never indexed or published. Chat commands wait for the settle (see
// `StructuredAgentSessionHostDeps.commandsReady`); listing, paint and status reads do not. A listed
// chat that is corrupt is left to the background restore after the listing, which is the same worker.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  deleteJournalSessionStatus,
  isUnsettledJournalSessionStatus,
  readJournalSessionStatuses,
  readUnsettledJournalSessionIds,
  type StoredJournalSessionStatus
} from '../agent-session-journal/journal-session-state'
import {
  openStructuredAgentSessionConversationJournal,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'
import { hasHistoryOutsideJournalDatabase } from './structured-agent-session-read-restore'
import {
  createStructuredAgentSessionStartupLeasePhase,
  type StructuredAgentSessionStartupLeasePhase
} from './structured-agent-session-startup-lease-phase'

export type StructuredAgentSessionStartupStateDeps = {
  openDeps: StructuredAgentSessionConversationOpenDeps & {
    store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  }
  /** Whether a chat can be settled here: its record exists. Reading and settling need no adapter. */
  canSettle: (record: AgentSessionRecord | null) => record is AgentSessionRecord
  seedStatus: (
    record: AgentSessionRecord,
    stored: { projected: StructuredAgentSessionStatusProjection; lastActivityAt: number }
  ) => void
  /** The restart lease check; false when it failed (reported by it). Never rejects. */
  reconcile: (sessionId: string) => Promise<boolean>
  /** Resolves a `recovering` lease; never throws (a failure is reported and left to the next
   *  attach or send). */
  resolveRecovery: (sessionId: string) => Promise<boolean>
  /** The restart restore's per-chat worker (lease bookkeeping, serialize, open, publish), with its
   *  lease bookkeeping answered by `leases`. */
  restoreListed: (
    records: AgentSessionRecord[],
    leases: StructuredAgentSessionStartupLeases
  ) => Promise<void>
  /** Tests shorten it; production takes the default. */
  recoveryBudgetMs?: number
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  isDisposed: () => boolean
}

/** A startup restore's lease bookkeeping, answered from the startup lease phase. */
export type StructuredAgentSessionStartupLeases = {
  reconcile: (sessionId: string) => Promise<boolean>
  resolveRecovery: (sessionId: string) => Promise<boolean>
}

export type StructuredAgentSessionStartupState = {
  /** The startup lease phase's check, which then starts every recovery. Never rejects. */
  reconcileRestartLeases: () => Promise<void>
  /** Seeds settled listed chats; answers the listed ids the background restore still opens. */
  seedStoredStatuses: (listedIds: readonly string[]) => string[]
  /** Settles every chat a gone process left with work, once per host. Never rejects. */
  settleOwedSessions: (listedIds: readonly string[]) => Promise<void>
  /** Every startup restore's lease bookkeeping, so none checks leases or recovers one twice. */
  leases: StructuredAgentSessionStartupLeases
}

export function createStructuredAgentSessionStartupState(
  deps: StructuredAgentSessionStartupStateDeps
): StructuredAgentSessionStartupState {
  const phase = createStructuredAgentSessionStartupLeasePhase({
    ...deps,
    store: deps.openDeps.store,
    logger: deps.openDeps.logger,
    budgetMs: deps.recoveryBudgetMs
  })
  const leases: StructuredAgentSessionStartupLeases = {
    reconcile: () => phase.reconciled(),
    resolveRecovery: phase.resolve
  }
  let settling: Promise<void> | null = null
  return {
    reconcileRestartLeases: async () => {
      await phase.reconciled()
      // Started now, awaited by the settle; the listing never waits on a recovery.
      if (!deps.openDeps.journalDatabase.readOnly) {
        void phase.recovered()
      }
    },
    seedStoredStatuses: (listedIds) => seedStoredStatuses(deps, listedIds),
    settleOwedSessions: (listedIds) => {
      settling ??= settleOwedSessions(deps, listedIds, phase, leases)
      return settling
    },
    leases
  }
}

function seedStoredStatuses(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[]
): string[] {
  const database = deps.openDeps.journalDatabase
  // A newer build's database: nothing is stored this build can read, and every chat reads as it does.
  if (database.readOnly) {
    return [...listedIds]
  }
  let stored: readonly StoredJournalSessionStatus[]
  try {
    stored = readJournalSessionStatuses(database.db, listedIds)
  } catch (error) {
    // Fails open: every listed chat is restored in the background, as before stored status existed.
    deps.openDeps.logger.warn('reading stored chat status failed', {
      scope: 'startup-status-read',
      error
    })
    return [...listedIds]
  }
  const byId = new Map(stored.map((row) => [row.sessionId, row.status]))
  const background: string[] = []
  for (const sessionId of listedIds) {
    // Its open (a restore, read or send) publishes its own status.
    if (deps.hasSession(sessionId)) {
      continue
    }
    const record = deps.openDeps.store.getRecord(sessionId)
    if (!record) {
      // Its record may still be owed by the records import: the restore reads records when it runs.
      background.push(sessionId)
      continue
    }
    if (!deps.canSettle(record)) {
      continue
    }
    if (!byId.has(sessionId)) {
      // Never sent opens nothing; a chat still in a per-chat file is opened from it in the background.
      if (hasHistoryOutsideJournalDatabase(database, record)) {
        background.push(sessionId)
      }
      continue
    }
    const status = byId.get(sessionId)
    if (status && isUnsettledJournalSessionStatus(status)) {
      // The settle's: its open settles and publishes.
      continue
    }
    if (!status || (status.summary.status !== null && status.summary.status !== 'idle')) {
      // No row this build can read: its open writes and publishes one.
      background.push(sessionId)
      continue
    }
    deps.seedStatus(record, { projected: status.summary, lastActivityAt: status.lastActivityAt })
  }
  return background
}

async function settleOwedSessions(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[],
  phase: StructuredAgentSessionStartupLeasePhase,
  leases: StructuredAgentSessionStartupLeases
): Promise<void> {
  try {
    const database = deps.openDeps.journalDatabase
    if (database.readOnly) {
      return
    }
    await phase.recovered()
    const listedOrder = new Map(listedIds.map((sessionId, index) => [sessionId, index]))
    const listed: AgentSessionRecord[] = []
    const others: AgentSessionRecord[] = []
    for (const sessionId of readUnsettledJournalSessionIds(database.db)) {
      const record = deps.openDeps.store.getRecord(sessionId)
      if (!deps.canSettle(record)) {
        dropUnreachableStatus(deps, sessionId, record)
        continue
      }
      if (listedOrder.has(sessionId)) {
        listed.push(record)
      } else {
        others.push(record)
      }
    }
    listed.sort(
      (left, right) =>
        (listedOrder.get(left.sessionId) ?? 0) - (listedOrder.get(right.sessionId) ?? 0)
    )
    await deps.restoreListed(listed, leases)
    // A listed chat the worker left closed (its tab closed meanwhile) is settled like any other,
    // unless its row is gone: an open that failed on its rows dropped it.
    const owed = new Set(readUnsettledJournalSessionIds(database.db))
    others.push(
      ...listed.filter((record) => !deps.hasSession(record.sessionId) && owed.has(record.sessionId))
    )
    for (const record of others) {
      // A journal open is synchronous SQLite: one chat per macrotask.
      await yieldToEventLoop()
      if (deps.isDisposed()) {
        return
      }
      // A check a command completed since the records were read may have moved this lease to
      // `recovering`: recover it, and settle from the record it left.
      await phase.resolve(record.sessionId)
      await deps
        .serialize(record.sessionId, () =>
          settleClosed(deps, deps.openDeps.store.getRecord(record.sessionId) ?? record)
        )
        .catch((error: unknown) => {
          deps.openDeps.logger.warn('settling a chat at startup failed', {
            scope: 'startup-settle-chat',
            sessionId: record.sessionId,
            error
          })
        })
    }
  } catch (error) {
    deps.openDeps.logger.warn('settling chats at startup failed', {
      scope: 'startup-settle',
      error
    })
  }
}

/**
 * A row no settle here can clear: its chat's record is gone. Dropped, so it is not selected every
 * boot; an open writes it again if the chat is ever opened here. Kept while the records import is
 * owed, which may still bring the record.
 */
function dropUnreachableStatus(
  deps: StructuredAgentSessionStartupStateDeps,
  sessionId: string,
  record: AgentSessionRecord | null
): void {
  const database = deps.openDeps.journalDatabase
  if (!record && database.legacyRecordImportOwed) {
    return
  }
  try {
    deleteJournalSessionStatus(database.db, sessionId)
  } catch (error) {
    deps.openDeps.logger.warn('dropping an unreachable chat status failed', {
      scope: 'startup-drop-status',
      sessionId,
      error
    })
  }
}

/** A chat nothing holds open: settled and closed, never indexed, so it gets no status row. */
async function settleClosed(
  deps: StructuredAgentSessionStartupStateDeps,
  record: AgentSessionRecord
): Promise<boolean> {
  if (deps.isDisposed() || deps.hasSession(record.sessionId)) {
    return false
  }
  const opened = await openStructuredAgentSessionConversationJournal(deps.openDeps, record, {
    deferPerSessionImport: true
  })
  await opened.session.journal.close()
  return true
}

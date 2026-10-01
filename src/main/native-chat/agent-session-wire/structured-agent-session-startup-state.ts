// What host startup does with the state stored beside each chat's journal, before any client
// lists a tab, and without opening a chat that owes nothing.
//
// Seed: every settled, listed chat's status row is published from its stored state, so session
// lists have it at paint. Settle: every chat whose stored state says its open owes work, listed or
// not, is opened once, one at a time, and its open appends the settlement plan. A listed one goes
// through the restart restore's own per-chat worker and stays open; an unlisted one is settled and
// closed, never indexed or published. Everything else a listed chat needs (a stale row, a per-chat
// file not yet copied, a draft the drain would send) is left to the background restore after the
// listing, which is the same worker.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { JournalLoad } from '../agent-session-journal/journal-open'
import { owesOnOpen } from '../agent-session-journal/journal-open-settlement-plan'
import {
  readJournalSessionStatesAtTip,
  readOwedJournalSessionStates,
  readSessionsWithDrainableDrafts
} from '../agent-session-journal/journal-session-state'
import {
  openStructuredAgentSessionConversationJournal,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'
import { hasHistoryOutsideJournalDatabase } from './structured-agent-session-read-restore'

export type StructuredAgentSessionStartupStateDeps = {
  openDeps: StructuredAgentSessionConversationOpenDeps & {
    store: Pick<AgentSessionRecordStore, 'getRecord'>
  }
  supportsRecord: (record: AgentSessionRecord) => boolean
  seedStatus: (
    record: AgentSessionRecord,
    stored: { projected: StructuredAgentSessionStatusProjection; lastActivityAt: number }
  ) => void
  /** The restart restore's per-chat worker (lease bookkeeping, serialize, open, publish). */
  restoreListed: (records: AgentSessionRecord[]) => Promise<void>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  isDisposed: () => boolean
}

export type StructuredAgentSessionStartupState = {
  /** Seeds settled listed chats; answers the listed ids the background restore still opens. */
  seedStoredStatuses: (listedIds: readonly string[]) => string[]
  /** Settles every chat that owes work, once per host. Never rejects. */
  settleOwedSessions: (listedIds: readonly string[]) => Promise<void>
  /** The settle step has started and not finished. */
  isSettling: () => boolean
  /** Settles a chat the background copy just copied, from the copy's load, with no replay. For a
   *  caller inside the chat's serialize. */
  settleCopiedUnlisted: (record: AgentSessionRecord, loaded: JournalLoad) => Promise<void>
}

export function createStructuredAgentSessionStartupState(
  deps: StructuredAgentSessionStartupStateDeps
): StructuredAgentSessionStartupState {
  let settling: Promise<void> | null = null
  let settled = false
  return {
    seedStoredStatuses: (listedIds) => seedStoredStatuses(deps, listedIds),
    settleOwedSessions: (listedIds) => {
      settling ??= settleOwedSessions(deps, listedIds).finally(() => {
        settled = true
      })
      return settling
    },
    isSettling: () => settling !== null && !settled,
    settleCopiedUnlisted: (record, loaded) => settleUnlisted(deps, record, loaded)
  }
}

function seedStoredStatuses(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[]
): string[] {
  const database = deps.openDeps.journalDatabase
  // A newer build's database: nothing is stored this build can trust, and every chat reads as it does.
  if (database.readOnly) {
    return [...listedIds]
  }
  let states: ReturnType<typeof readJournalSessionStatesAtTip>
  let drafts: Set<string>
  try {
    states = readJournalSessionStatesAtTip(database.db, listedIds)
    drafts = readSessionsWithDrainableDrafts(database.db)
  } catch (error) {
    // Fails open: every listed chat is restored in the background, as before stored state existed.
    console.warn('[structured-agent-session] reading stored chat state failed', error)
    return [...listedIds]
  }
  const byId = new Map(states.map((state) => [state.sessionId, state.current]))
  const background: string[] = []
  for (const sessionId of listedIds) {
    const record = deps.openDeps.store.getRecord(sessionId)
    if (!record) {
      // Its record may still be owed by the records import: the restore reads records when it runs.
      background.push(sessionId)
      continue
    }
    if (!deps.supportsRecord(record)) {
      continue
    }
    if (!byId.has(sessionId)) {
      // Never sent opens nothing; a per-chat file not yet copied is read in the background.
      if (hasHistoryOutsideJournalDatabase(database, record)) {
        background.push(sessionId)
      }
      continue
    }
    const stored = byId.get(sessionId)
    if (stored && owesOnOpen(stored, record.lease.deathEvidence)) {
      // The settle step's: its open settles and publishes.
      continue
    }
    const status = stored?.summary?.status
    if (!stored?.summary || (status !== null && status !== 'idle')) {
      // Stale, or describing a state nothing owed cannot reach: re-derived by its open.
      background.push(sessionId)
      continue
    }
    deps.seedStatus(record, { projected: stored.summary, lastActivityAt: stored.lastActivityAt })
    if (drafts.has(sessionId)) {
      // Opened so the drain runs on open, as the restore always did.
      background.push(sessionId)
    }
  }
  return background
}

async function settleOwedSessions(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[]
): Promise<void> {
  try {
    const database = deps.openDeps.journalDatabase
    if (database.readOnly) {
      return
    }
    const listedOrder = new Map(listedIds.map((sessionId, index) => [sessionId, index]))
    const listed: AgentSessionRecord[] = []
    const unlisted: AgentSessionRecord[] = []
    for (const owed of readOwedJournalSessionStates(database.db)) {
      const record = deps.openDeps.store.getRecord(owed.sessionId)
      if (
        !record ||
        !deps.supportsRecord(record) ||
        !owesOnOpen(owed, record.lease.deathEvidence)
      ) {
        continue
      }
      if (listedOrder.has(record.sessionId)) {
        listed.push(record)
      } else {
        unlisted.push(record)
      }
    }
    listed.sort(
      (left, right) =>
        (listedOrder.get(left.sessionId) ?? 0) - (listedOrder.get(right.sessionId) ?? 0)
    )
    await deps.restoreListed(listed)
    for (const record of unlisted) {
      // A journal open is synchronous SQLite: one chat per macrotask.
      await yieldToEventLoop()
      if (deps.isDisposed()) {
        return
      }
      await deps
        .serialize(record.sessionId, () => settleUnlisted(deps, record))
        .catch((error: unknown) => {
          console.warn('[structured-agent-session] settling a chat at startup failed', {
            sessionId: record.sessionId,
            error
          })
        })
    }
  } catch (error) {
    console.warn('[structured-agent-session] settling chats at startup failed', error)
  }
}

/** A chat with no tab: settled and closed, never indexed, so it gets no status row. */
async function settleUnlisted(
  deps: StructuredAgentSessionStartupStateDeps,
  record: AgentSessionRecord,
  loaded?: JournalLoad
): Promise<void> {
  if (deps.isDisposed() || deps.hasSession(record.sessionId)) {
    return
  }
  const opened = await openStructuredAgentSessionConversationJournal(deps.openDeps, record, {
    deferPerSessionImport: true,
    ...(loaded ? { loaded } : {})
  })
  await opened.session.journal.close()
}

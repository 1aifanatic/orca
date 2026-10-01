// The background copy's second phase: a status row for every chat already in the host's database
// that has none (see journal-session-status-backfill.ts), one chat per step, inside that chat's
// serialize. A chat a crash left with work is settled at once from the same replay, as a copied
// chat is, so startup never has to find it. A chat whose record is gone is skipped: nothing lists
// or settles it, so its row would answer nobody. A row that fails for good is given up on while
// the chat's rows and the app version stay as they were (journal-background-failures.ts).

import {
  classifyJournalBackgroundFailure,
  recordJournalBackgroundFailure
} from '../agent-session-journal/journal-background-failures'
import {
  backfillJournalSessionStatus,
  journalStatusInput,
  readJournalSessionIdsWithoutStatus
} from '../agent-session-journal/journal-session-status-backfill'
import type { PerChatFileCopyDeps } from './structured-agent-session-per-chat-file-copy'

export type StatusBackfillStep = 'backfilled' | 'skipped' | 'done'

type StatusBackfillDeps = Pick<
  PerChatFileCopyDeps,
  | 'database'
  | 'store'
  | 'serialize'
  | 'openJournal'
  | 'settleCopied'
  | 'isDisposed'
  | 'now'
  | 'appVersion'
>

/** The chats the phase owes a row, in the order it writes them. */
export function readStatusBackfillOwed(
  deps: Pick<StatusBackfillDeps, 'database' | 'store' | 'appVersion'>
): string[] {
  return readJournalSessionIdsWithoutStatus(deps.database.db, deps.appVersion).filter(
    (sessionId) => deps.store.getRecord(sessionId) !== null
  )
}

export function createStructuredAgentSessionStatusBackfill(deps: StatusBackfillDeps): {
  next: () => Promise<StatusBackfillStep>
} {
  let owed: string[] | null = null
  const logged = new Set<string>()
  const warnOnce = (key: string, message: string, details: unknown) => {
    if (!logged.has(key)) {
      logged.add(key)
      console.warn(`[structured-agent-session] ${message}`, details)
    }
  }
  const underSerialize = async (sessionId: string): Promise<boolean> => {
    // An open chat writes its own row; quit writes nothing more.
    if (deps.isDisposed() || deps.database.importsAborted || deps.openJournal(sessionId)) {
      return false
    }
    const written = await backfillJournalSessionStatus(deps.database, sessionId)
    if (written) {
      await deps.settleCopied(sessionId, written)
    }
    return written !== null
  }
  const onFailure = (sessionId: string, error: unknown): StatusBackfillStep => {
    const kind = classifyJournalBackgroundFailure(error)
    if (kind === 'deterministic') {
      recordJournalBackgroundFailure(deps.database.db, {
        sessionId,
        step: 'status',
        readInput: () => journalStatusInput(deps.database.db, sessionId),
        appVersion: deps.appVersion,
        error,
        failedAt: deps.now()
      })
    }
    warnOnce(sessionId, `writing a missing chat status failed (${kind})`, { sessionId, error })
    return 'skipped'
  }
  return {
    next: async () => {
      try {
        // Read once the old files are done, so a chat copied meanwhile is not read twice.
        owed ??= readStatusBackfillOwed(deps)
      } catch (error) {
        warnOnce('', 'reading chats without a status failed', error)
        owed = []
      }
      const sessionId = owed.shift()
      if (sessionId === undefined) {
        return 'done'
      }
      try {
        const wrote = await deps.serialize(sessionId, () => underSerialize(sessionId))
        return wrote ? 'backfilled' : 'skipped'
      } catch (error) {
        return onFailure(sessionId, error)
      }
    }
  }
}

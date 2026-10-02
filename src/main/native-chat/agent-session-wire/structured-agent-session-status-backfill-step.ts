// The background copy's second phase: a status row for every chat already in the host's database
// that has none (see journal-session-status-backfill.ts), one chat per step, inside that chat's
// serialize. A chat a crash left with work is settled at once from the same replay, as a copied
// chat is, so startup never has to find it. A chat this host cannot settle (its record is gone, or
// its provider is not served here) is skipped: startup drops such a row, so writing it would loop
// every launch. A row that fails for good is given up on while the chat's rows and the app version
// stay as they were (journal-background-failures.ts). A chat starting work stops the step, which
// is owed again once the chats are quiet.

import {
  classifyJournalBackgroundFailure,
  recordJournalBackgroundFailure
} from '../agent-session-journal/journal-background-failures'
import type { JournalLoad } from '../agent-session-journal/journal-open'
import {
  isUnsettledJournalSessionStatus,
  type JournalSessionStatus
} from '../agent-session-journal/journal-session-state'
import { backfillJournalSessionStatus } from '../agent-session-journal/journal-session-status-backfill'
import {
  journalStatusInput,
  readJournalSessionIdsWithoutStatus
} from '../agent-session-journal/journal-session-status-owed'
import type { PerChatFileCopyDeps } from './structured-agent-session-per-chat-file-copy'
import type { PerChatFileCopyChat } from './structured-agent-session-per-chat-file-copy-activity'

export type StatusBackfillStep = 'backfilled' | 'skipped' | 'stop' | 'done'

type StatusBackfillDeps = Pick<
  PerChatFileCopyDeps,
  | 'database'
  | 'store'
  | 'openJournal'
  | 'settleClosedChat'
  | 'canSettle'
  | 'isDisposed'
  | 'now'
  | 'appVersion'
  | 'logger'
> & {
  /** Runs a step inside the chat's lock, handing it the yield that ends each of its tasks. */
  inChat: <T>(sessionId: string, task: (yieldTask: () => Promise<void>) => Promise<T>) => Promise<T>
  forChat: () => PerChatFileCopyChat
}

/** The chats the phase owes a row, in the order it writes them. */
export function readStatusBackfillOwed(
  deps: Pick<StatusBackfillDeps, 'database' | 'store' | 'canSettle' | 'appVersion'>
): string[] {
  return readJournalSessionIdsWithoutStatus(deps.database.db, deps.appVersion).filter((sessionId) =>
    deps.canSettle(deps.store.getRecord(sessionId))
  )
}

/** Settles a chat the job just wrote a status row for (a copy or this phase), from the load it
 *  wrote that row from, when the row shows work a gone process left. Inside the chat's serialize.
 *  Never rejects: a failure is logged, and the next startup settles the row. */
export async function settleWrittenChat(
  deps: Pick<StatusBackfillDeps, 'store' | 'settleClosedChat' | 'logger'>,
  sessionId: string,
  { load, status }: { load: JournalLoad; status: JournalSessionStatus }
): Promise<void> {
  const record = deps.store.getRecord(sessionId)
  // A newer build's rows stay unwritten.
  if (!record || load.readOnly || !isUnsettledJournalSessionStatus(status)) {
    return
  }
  try {
    await deps.settleClosedChat(record, load)
  } catch (error) {
    deps.logger.warn('settling a copied chat failed', {
      scope: 'per-chat-file-copy-settle',
      sessionId,
      error
    })
  }
}

export function createStructuredAgentSessionStatusBackfill(deps: StatusBackfillDeps): {
  next: () => Promise<StatusBackfillStep>
} {
  let owed: string[] | null = null
  const logged = new Set<string>()
  const warnOnce = (key: string, message: string, error: unknown) => {
    if (!logged.has(key)) {
      logged.add(key)
      deps.logger.warn(message, {
        scope: 'per-chat-file-copy-status',
        ...(key ? { sessionId: key } : {}),
        error
      })
    }
  }
  const underSerialize = async (
    sessionId: string,
    { yieldTask, signal }: { yieldTask: () => Promise<void>; signal: AbortSignal }
  ): Promise<boolean> => {
    // An open chat writes its own row; a stopped step writes nothing more.
    if (deps.isDisposed() || signal.aborted || deps.openJournal(sessionId)) {
      return false
    }
    const written = await backfillJournalSessionStatus(deps.database, sessionId, {
      yieldTask,
      signal
    })
    // A stopped settle leaves the row to startup's settle, as a failed one does.
    if (written && !signal.aborted) {
      await settleWrittenChat(deps, sessionId, written)
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
    warnOnce(sessionId, `writing a missing chat status failed (${kind})`, error)
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
      const chat = deps.forChat()
      const stopForWork = (): StatusBackfillStep => {
        owed?.unshift(sessionId)
        return 'stop'
      }
      try {
        const wrote = await deps.inChat(sessionId, (yieldTask) =>
          underSerialize(sessionId, { yieldTask, signal: chat.signal })
        )
        if (wrote) {
          return 'backfilled'
        }
        return chat.stoppedByWork() ? stopForWork() : 'skipped'
      } catch (error) {
        return chat.stoppedByWork() ? stopForWork() : onFailure(sessionId, error)
      } finally {
        chat.release()
      }
    }
  }
}

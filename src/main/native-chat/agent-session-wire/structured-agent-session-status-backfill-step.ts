// The background copy's second phase: a status row for every chat already in the host's database
// that has none (see journal-session-status-backfill.ts), one chat per step, inside that chat's
// serialize. A chat a crash left with work is settled at once from the same replay, as a copied
// chat is, so startup never has to find it.

import type { JournalLoad } from '../agent-session-journal/journal-open'
import {
  isUnsettledJournalSessionStatus,
  type JournalSessionStatus
} from '../agent-session-journal/journal-session-state'
import {
  backfillJournalSessionStatus,
  readJournalSessionIdsWithoutStatus
} from '../agent-session-journal/journal-session-status-backfill'
import type { PerChatFileCopyDeps } from './structured-agent-session-per-chat-file-copy'

export type StatusBackfillStep = 'backfilled' | 'skipped' | 'done'

export function createStructuredAgentSessionStatusBackfill(
  deps: Pick<
    PerChatFileCopyDeps,
    'database' | 'store' | 'serialize' | 'openJournal' | 'settleCopied' | 'isDisposed'
  >
): { next: () => Promise<StatusBackfillStep> } {
  let owed: string[] | null = null
  const logged = new Set<string>()
  const underSerialize = async (sessionId: string): Promise<boolean> => {
    // An open chat writes its own row; quit writes nothing more.
    if (deps.isDisposed() || deps.database.importsAborted || deps.openJournal(sessionId)) {
      return false
    }
    const written = await backfillJournalSessionStatus(deps.database, sessionId)
    const record = deps.store.getRecord(sessionId)
    if (written && record && needsSettle(written)) {
      await deps.settleCopied(record, written.load)
    }
    return written !== null
  }
  return {
    next: async () => {
      // Read once the old files are done, so a chat copied meanwhile is not read twice.
      owed ??= readJournalSessionIdsWithoutStatus(deps.database.db)
      const sessionId = owed.shift()
      if (sessionId === undefined) {
        return 'done'
      }
      try {
        const wrote = await deps.serialize(sessionId, () => underSerialize(sessionId))
        return wrote ? 'backfilled' : 'skipped'
      } catch (error) {
        if (!logged.has(sessionId)) {
          logged.add(sessionId)
          console.warn('[structured-agent-session] writing a missing chat status failed', {
            sessionId,
            error
          })
        }
        return 'skipped'
      }
    }
  }
}

function needsSettle(written: { load: JournalLoad; status: JournalSessionStatus }): boolean {
  // A newer build's rows stay unwritten; anything else is settled by the rule startup selects by.
  return !written.load.readOnly && isUnsettledJournalSessionStatus(written.status)
}

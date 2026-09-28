// What a failed journal open means for the chat: its history is damaged, which no retry reads
// past, or the open failed in a way that can clear (a lock, permissions, too many open files).

import type { AgentSessionRefusalReason } from '../../../shared/agent-session-refusal-details'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  refuse,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'
import { JournalDatabaseNewerSchemaError } from './journal-database'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalOpenFailure = Exclude<
  AgentSessionRefusalReason<'agent_session_journal_unreadable'>,
  'journalOwnedElsewhere'
>

/** A per-chat file whose copy did not read back as the file: the history is not usable here. */
export class JournalImportMismatchError extends Error {
  override readonly name = 'JournalImportMismatchError'
}

// Bounds a cause chain that loops back on itself.
const MAX_CAUSE_DEPTH = 8

/** Damage only where the storage says so; anything unproven can clear. */
export function classifyJournalOpenFailure(error: unknown): JournalOpenFailure {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (isSqliteCorruption(current) || current instanceof JournalImportMismatchError) {
      return 'journalCorrupt'
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return 'journalUnavailable'
}

// Released clients print a refusal's message for a send; it fits a Stop too.
const JOURNAL_OPEN_MESSAGE: Record<JournalOpenFailure, string> = {
  journalCorrupt: agentSessionWriteNoticeEnglish(['historyUnusable']),
  journalUnavailable: agentSessionWriteNoticeEnglish(['historyUnavailable', 'tryAgain'])
}

export const JOURNAL_NEWER_SCHEMA_MESSAGE =
  'Chats were saved by a newer Orca. Update Orca to keep using them.'

/** A newer Orca wrote the database, or one of this chat's rows: an update is what gets past it. */
export function isJournalWrittenByNewerOrca(error: unknown): boolean {
  return (
    error instanceof JournalDatabaseNewerSchemaError ||
    (error instanceof AgentSessionJournalError && error.code === 'journal_read_only')
  )
}

/** Why a journal open failed, and the words a released client prints for it. */
function journalOpenFailureWords(error: unknown): { reason: JournalOpenFailure; message: string } {
  if (isJournalWrittenByNewerOrca(error)) {
    // Clears when this Orca is updated, so it is not damage.
    return { reason: 'journalUnavailable', message: JOURNAL_NEWER_SCHEMA_MESSAGE }
  }
  const reason = classifyJournalOpenFailure(error)
  return { reason, message: JOURNAL_OPEN_MESSAGE[reason] }
}

/** The refusal a failed journal open answers with, as the wire carries it. */
export function journalOpenRefusal(error: unknown): AgentSessionWireRefusal {
  const { reason, message } = journalOpenFailureWords(error)
  return refuse('agent_session_journal_unreadable', { reason }, message)
}

/** The same refusal, thrown: for a host that could not open the journal at all. */
export function journalOpenRefusalError(error: unknown): AgentSessionRefusalError {
  const { reason, message } = journalOpenFailureWords(error)
  return agentSessionRefusalError('agent_session_journal_unreadable', { reason }, message)
}

/**
 * What a read throws when the conversation it reaches cannot be opened. The storage's own text
 * (a path, "file is not a database") goes to the log only; the reader gets the classified refusal,
 * whose message stays the bare code.
 */
export function journalOpenReadRefusal(error: unknown): AgentSessionRefusalError {
  if (isAgentSessionRefusalError(error)) {
    return error
  }
  return unreadableRefusal(error, classifyJournalOpenFailure(error), true)
}

const MAX_LOGGED_SESSIONS = 256

/**
 * The read door's refusals for one host. A reader reconnects on a timer while an open can clear,
 * so a session's failure is logged once until that session opens or the failure changes.
 */
export function createJournalOpenReadRefusals() {
  const logged = new Map<string, string>()
  return {
    refusal: (sessionId: string, error: unknown): AgentSessionRefusalError => {
      if (isAgentSessionRefusalError(error)) {
        return error
      }
      const reason = classifyJournalOpenFailure(error)
      const failure = `${reason}:${error instanceof Error ? error.message : String(error)}`
      const repeat = logged.get(sessionId) === failure
      // Past the cap a new session logs every failure rather than evict another's.
      if (!repeat && (logged.has(sessionId) || logged.size < MAX_LOGGED_SESSIONS)) {
        logged.set(sessionId, failure)
      }
      return unreadableRefusal(error, reason, !repeat)
    },
    /** The session opened or closed: its next failure is news. */
    forget: (sessionId: string): void => {
      logged.delete(sessionId)
    }
  }
}

function unreadableRefusal(
  error: unknown,
  reason: JournalOpenFailure,
  log: boolean
): AgentSessionRefusalError {
  if (log) {
    console.warn('[agent-session] opening the conversation for a read failed:', error)
  }
  const code = 'agent_session_journal_unreadable'
  return new AgentSessionRefusalError(refuse(code, { reason }, code), { cause: error })
}

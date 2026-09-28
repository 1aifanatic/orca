// Opening the chat journal database under this process's owner lock, for the host install.

import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { journalOpenRefusalError } from '../native-chat/agent-session-journal/journal-open-failure'
import {
  claimStructuredAgentSessionJournal,
  recordStructuredAgentSessionHostInstallRefusal,
  structuredAgentSessionJournalOwnerRefusal
} from './structured-agent-session-journal-ownership'

// Every chat request retries a failed open, so each distinct failure is logged once, with its stack.
let lastLoggedOpenFailure: string | null = null

function logOpenFailureOnce(error: unknown): void {
  const failure =
    error instanceof Error
      ? `${'code' in error ? String(error.code) : ''}:${error.message}`
      : String(error)
  if (failure === lastLoggedOpenFailure) {
    return
  }
  lastLoggedOpenFailure = failure
  console.warn('[structured-agent-session] opening the chat journal database failed', error)
}

/** The journal database, opened only under this process's owner lock. A refusal is recorded for
 *  the gate and thrown to the caller; the next install tries again. A lock file that cannot be
 *  opened at all refuses like the database it guards, until the claim's retry takes the lock. */
export function openOwnedJournalDatabase(stateDirectory: string): JournalHostDatabase {
  try {
    const lock = claimStructuredAgentSessionJournal(stateDirectory)
    if (lock) {
      const opened = JournalHostDatabase.open(lock)
      recordStructuredAgentSessionHostInstallRefusal(null)
      lastLoggedOpenFailure = null
      return opened
    }
  } catch (error) {
    logOpenFailureOnce(error)
    // Nothing is renamed, deleted or rebuilt: the file is left exactly as it is.
    const refusal = journalOpenRefusalError(error)
    recordStructuredAgentSessionHostInstallRefusal(refusal)
    throw refusal
  }
  throw (
    structuredAgentSessionJournalOwnerRefusal() ??
    new Error('the chat journal owner lock was refused')
  )
}

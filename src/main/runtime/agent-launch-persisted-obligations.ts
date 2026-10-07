import { existsSync } from 'node:fs'
import {
  journalDatabaseHoldsLaunchObligation,
  type LaunchOperationObligation
} from '../native-chat/agent-session-journal/journal-database'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'

/**
 * Whether this profile's launch records still owe work of this kind, read without opening the
 * record store: a profile with no database, or none owed, neither opens nor creates one at startup.
 * A terminal-only profile has launch records and no chat, so the chat-store check cannot answer.
 */
export function hasPersistedLaunchObligation(
  stateDirectory: string,
  field: LaunchOperationObligation,
  now: number = Date.now(),
  fileExists: (path: string) => boolean = existsSync
): boolean {
  const databasePath = journalDatabasePath(stateDirectory)
  if (!fileExists(databasePath)) {
    return false
  }
  try {
    return journalDatabaseHoldsLaunchObligation(databasePath, field, now)
  } catch {
    // A database that cannot be read cannot say it owes nothing.
    return true
  }
}

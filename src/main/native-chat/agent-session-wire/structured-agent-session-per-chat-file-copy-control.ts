// Starting and stopping the host's background copy of old per-chat files: once per host, whatever
// calls startup restoration again, and stopped first at teardown.

import { existsSync } from 'node:fs'
import { perChatJournalRoot } from '../agent-session-journal/journal-paths'
import { hasJournalSessionWithoutStatus } from '../agent-session-journal/journal-session-status-backfill'
import {
  StructuredAgentSessionPerChatFileCopy,
  type PerChatFileCopyDeps
} from './structured-agent-session-per-chat-file-copy'

/** Starts the job, or returns null when there is nothing it may do: a newer build's database, a
 *  records file this launch could not read (a real chat's file would look like an orphan), or no
 *  old-file root and no chat without a status row. */
export function startStructuredAgentSessionPerChatFileCopy(
  deps: PerChatFileCopyDeps
): StructuredAgentSessionPerChatFileCopy | null {
  const { database } = deps
  if (
    database.readOnly ||
    database.legacyRecordImportOwed ||
    database.isClosed ||
    (!existsSync(perChatJournalRoot(database.stateDirectory)) &&
      !hasJournalSessionWithoutStatus(database.db))
  ) {
    return null
  }
  const job = new StructuredAgentSessionPerChatFileCopy(deps)
  job.start()
  return job
}

export type PerChatFileCopyStart = {
  listedIds: readonly string[]
  /** The runtime's own startup chat work: a tab listing, or a history restore owed or starting. */
  isRuntimeChatWorkActive: () => boolean
}

/** The host's one job: started once whatever calls startup restoration again, and stopped first
 *  at teardown. */
export function createStructuredAgentSessionPerChatFileCopyControl(
  base: Omit<PerChatFileCopyDeps, 'listedIds' | 'isStartupChatWorkActive'> & {
    /** The host's own startup chat work: the settle step, or a history restore running. */
    isHostChatWorkActive: () => boolean
  }
): { start: (input: PerChatFileCopyStart) => void; stop: () => Promise<void> } {
  const { isHostChatWorkActive, ...deps } = base
  let started = false
  let job: StructuredAgentSessionPerChatFileCopy | null = null
  return {
    start: (input) => {
      if (started) {
        return
      }
      started = true
      job = startStructuredAgentSessionPerChatFileCopy({
        ...deps,
        listedIds: input.listedIds,
        isStartupChatWorkActive: () => input.isRuntimeChatWorkActive() || isHostChatWorkActive()
      })
    },
    stop: async () => {
      // Every import stops at its next batch, the job's and a restored chat's owed one alike.
      deps.database.abortImports()
      await job?.stop()
    }
  }
}

// The background pass's first step after an upgrade: listed chats with history here and no status
// row get their rows from their rows alone, without an open. Chats fold one per task; their rows are
// written a slice at a time, in one transaction per slice, so the pass appends few WAL pages.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  foldJournalSessionStatus,
  writeJournalSessionStatuses,
  type FoldedJournalSessionStatus
} from '../agent-session-journal/journal-session-status-backfill'
import { isUnsettledJournalSessionStatus } from '../agent-session-journal/journal-session-state'
import type { StructuredAgentSessionStartupStateDeps } from './structured-agent-session-startup-state'

// A write per slice, not per chat: each per-chat commit rewrites the same table and index pages.
const SLICE_CHATS = 16
const SLICE_MS = 50

type Folded = FoldedJournalSessionStatus & { record: AgentSessionRecord }

/** Answers the chats still to open, in the order given: the rest, and any whose rows show work a
 *  gone process left or owe a rebuild, which their open settles or rebuilds. */
export async function deriveMissingStatuses(
  deps: StructuredAgentSessionStartupStateDeps,
  sessionIds: readonly string[]
): Promise<string[]> {
  if (deps.openDeps.journalDatabase.readOnly) {
    return [...sessionIds]
  }
  // Quit stops a fold within one part, and nothing more is written.
  const quit = new AbortController()
  const yieldTask = async () => {
    await yieldToEventLoop()
    if (deps.isDisposed()) {
      quit.abort()
    }
  }
  const toOpen: string[] = []
  let slice: Folded[] = []
  let sliceStart = 0
  for (const sessionId of sessionIds) {
    // A task per chat at least: short chats fold in one part, and a pass of them must not be one task.
    await yieldTask()
    if (deps.isDisposed()) {
      return []
    }
    const record = deps.openDeps.store.getRecord(sessionId)
    const folded =
      record && deps.canSettle(record) && !deps.hasSession(sessionId)
        ? await foldFromRows(deps, record, { yieldTask, signal: quit.signal })
        : null
    if (!folded) {
      toOpen.push(sessionId)
      continue
    }
    if (slice.length === 0) {
      sliceStart = performance.now()
    }
    slice.push(folded)
    if (slice.length >= SLICE_CHATS || performance.now() - sliceStart >= SLICE_MS) {
      toOpen.push(...writeSlice(deps, slice))
      slice = []
    }
  }
  if (deps.isDisposed()) {
    return []
  }
  toOpen.push(...writeSlice(deps, slice))
  return toOpen
}

/** A chat's settled status from its rows; null leaves it to its open. */
async function foldFromRows(
  deps: StructuredAgentSessionStartupStateDeps,
  record: AgentSessionRecord,
  options: { yieldTask: () => Promise<void>; signal: AbortSignal }
): Promise<Folded | null> {
  try {
    const folded = await foldJournalSessionStatus(
      deps.openDeps.journalDatabase,
      record.sessionId,
      options
    )
    // Work a gone process left is settled, and a corrupt history rebuilt, by the chat's open.
    if (!folded || folded.load.corrupt || isUnsettledJournalSessionStatus(folded.status)) {
      return null
    }
    return { ...folded, record }
  } catch (error) {
    deps.openDeps.logger.warn('deriving a chat status from its rows failed', {
      scope: 'startup-status-derive',
      sessionId: record.sessionId,
      error
    })
    return null
  }
}

/** Writes the slice's rows in one transaction and seeds each written chat; answers the chats left to
 *  their open (one a send or an open moved meanwhile, or all of them if the write failed). */
function writeSlice(deps: StructuredAgentSessionStartupStateDeps, slice: Folded[]): string[] {
  let written: FoldedJournalSessionStatus[]
  try {
    written = writeJournalSessionStatuses(deps.openDeps.journalDatabase, slice)
  } catch (error) {
    deps.openDeps.logger.warn('writing chat statuses derived from their rows failed', {
      scope: 'startup-status-derive',
      error
    })
    return slice.map(({ sessionId }) => sessionId)
  }
  const writtenIds = new Set(written.map(({ sessionId }) => sessionId))
  for (const folded of slice) {
    if (writtenIds.has(folded.sessionId)) {
      deps.seedStatus(folded.record, {
        projected: folded.status.summary,
        lastActivityAt: folded.status.lastActivityAt
      })
    }
  }
  return slice.flatMap(({ sessionId }) => (writtenIds.has(sessionId) ? [] : [sessionId]))
}

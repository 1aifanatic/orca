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

/** `shown` false: an unfinished chat's row, stored so the next boot selects the chat until its open
 *  settles it, but never displayed from rows. */
type Folded = FoldedJournalSessionStatus & { record: AgentSessionRecord; shown: boolean }

/** Answers the chats still to open: the chats it could not fold, those with a corrupt history
 *  (given no row, so every boot opens one until its rebuild), and those whose rows show work a gone
 *  process left, which their open settles, in the order given; then, after each slice's write, the
 *  chats of that slice the write had to skip. */
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
    if (!folded || !folded.shown) {
      toOpen.push(sessionId)
    }
    if (!folded) {
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

/** A chat's status from its rows; null leaves it to its open, rowless, as for a corrupt history: a
 *  stored row would let the next boot seed it and skip the open its rebuild needs. One with work a
 *  gone process left is still written, so startup selects it until its open settles it, but it is
 *  never shown: only its open publishes its status. */
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
    if (!folded || folded.load.corrupt) {
      return null
    }
    return { ...folded, record, shown: !isUnsettledJournalSessionStatus(folded.status) }
  } catch (error) {
    deps.openDeps.logger.warn('deriving a chat status from its rows failed', {
      scope: 'startup-status-derive',
      sessionId: record.sessionId,
      error
    })
    return null
  }
}

/** Writes the slice's rows in one transaction and seeds each written chat still listed and closed;
 *  answers the shown chats left to their open (one a send or an open moved meanwhile, or all of them
 *  if the write failed). */
function writeSlice(deps: StructuredAgentSessionStartupStateDeps, slice: Folded[]): string[] {
  let written: FoldedJournalSessionStatus[]
  try {
    written = writeJournalSessionStatuses(deps.openDeps.journalDatabase, slice)
  } catch (error) {
    deps.openDeps.logger.warn('writing chat statuses derived from their rows failed', {
      scope: 'startup-status-derive',
      error
    })
    return slice.flatMap(({ sessionId, shown }) => (shown ? [sessionId] : []))
  }
  const writtenIds = new Set(written.map(({ sessionId }) => sessionId))
  for (const folded of slice) {
    // A tab closed since the fold gets no sidebar row; one opened since publishes its own.
    if (
      folded.shown &&
      writtenIds.has(folded.sessionId) &&
      deps.isListed(folded.sessionId) &&
      !deps.hasSession(folded.sessionId)
    ) {
      deps.seedStatus(folded.record, {
        projected: folded.status.summary,
        lastActivityAt: folded.status.lastActivityAt
      })
    }
  }
  return slice.flatMap(({ sessionId, shown }) =>
    shown && !writtenIds.has(sessionId) ? [sessionId] : []
  )
}

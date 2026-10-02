// Republishing a live item set into a fresh epoch.
//
// One transaction: discard the old epoch's rows, insert the epoch row plus the
// replacement items, move the session projection, and retire any repair marker
// — this republished history is exactly what the marker was holding out for.
// A newer build's rows its writer declared `carry` are carried, not discarded:
// that build still reads them after a downgrade and upgrade.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { clearJournalRepairMarker } from './journal-repair-marker'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import {
  buildJournalQueueResumeRow,
  buildJournalStopEventRow
} from './journal-stop-and-resume-rows'
import type { JournalQueuePauseRestatement } from './queued-message-pause'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  insertJournalStoredRow,
  publishJournalSessionEpoch,
  readJournalRow,
  readJournalSessionEpoch,
  type JournalStoredRow
} from './journal-row-table'
import {
  parseJournalRow,
  type AgentJournalEpochReason,
  type JournalRow
} from './journal-row-schema'
import { restampSkippedJournalRow } from './journal-skipped-row'
import { assertJournalFence } from './journal-write-guards'

export type JournalReplacementItem = AgentJournalProducerLinkage & {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
  /** Absent for history rebuilt from a source that never stated one: derived from position, as
   *  a legacy row's is, and then written down. */
  turnScope?: AgentJournalTurnScope
}

export function replaceJournalEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
  /** Restated in the new epoch, or the rewind would release cards the person stopped, or bring
   *  back a /clear pause they already lifted. */
  queuePause: JournalQueuePauseRestatement
  /** The live epoch's rows of a newer build's kind, declared `carry`. */
  carrySequences: readonly number[]
  now: () => number
  mintEpoch: () => string
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const epoch = input.mintEpoch()
  const state = createJournalReducerState(input.identity.sessionId, epoch)
  const epochRow: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.identity.providerHandle,
    ...journalRowBase(epoch, 1, input.fence, input.now())
  }
  const rows: JournalRow[] = [epochRow]
  applyJournalRow(state, epochRow)
  for (const item of input.items) {
    const row = buildJournalItemRow({
      state,
      identity: item.identity,
      body: item.body,
      seq: state.lastSequence + 1,
      fence: input.fence,
      ts: item.observedAt ?? input.now(),
      linkage: item,
      turnScope: item.turnScope ?? state.derivedTurnScope.scopeFor(item.body)
    })
    assertJournalFence(row.fence, state.highestFence)
    applyJournalRow(state, row)
    rows.push(row)
  }
  const { lifted, liveStop } = input.queuePause
  const place = () => ({ state, seq: state.lastSequence + 1, fence: input.fence, ts: input.now() })
  if (lifted) {
    const row = buildJournalQueueResumeRow(place())
    applyJournalRow(state, row)
    rows.push(row)
  }
  if (liveStop) {
    const row = buildJournalStopEventRow({ ...place(), event: liveStop })
    applyJournalRow(state, row)
    rows.push(row)
  }

  const { sessionId } = input.identity
  // Last, in source order: their writer vouched they mean the same at any later place.
  const carried: JournalStoredRow[] = []
  for (const stored of readLiveJournalRows(input.database, sessionId, input.carrySequences)) {
    const parsed = parseJournalRow(stored.rowJson)
    const skipped = !parsed.ok && parsed.skipped
    if (!skipped || skipped.ifUnknown !== 'carry') {
      continue
    }
    const at = { epoch, seq: state.lastSequence + 1, fence: input.fence }
    const moved = restampSkippedJournalRow(stored.rowJson, skipped, at)
    if (moved) {
      applyJournalRow(state, moved.row)
      carried.push({ epoch, seq: moved.row.seq, ts: moved.row.ts, rowJson: moved.rowJson })
    }
  }

  input.database.transaction((db) => {
    const retired = readJournalSessionEpoch(db, sessionId)
    if (retired !== null) {
      deleteJournalEpochRows(db, sessionId, retired)
    }
    clearJournalRepairMarker(db, sessionId)
    for (const row of rows) {
      insertJournalRow(db, sessionId, row)
    }
    for (const row of carried) {
      insertJournalStoredRow(db, sessionId, row)
    }
    publishJournalSessionEpoch(db, input.identity, epoch)
  })

  // COMMIT landed: on disk the superseded rows are gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // live store writing into an epoch whose rows were just deleted.
  state.oldestSequence = 1
  input.onPublished({ state, readOnly: false, corrupt: false, malformedRows: 0 })
}

/** The live epoch's rows at these sequences, as stored. */
function readLiveJournalRows(
  database: JournalHostDatabase,
  sessionId: string,
  sequences: readonly number[]
): JournalStoredRow[] {
  const live = readJournalSessionEpoch(database.db, sessionId)
  return live === null
    ? []
    : sequences.flatMap((seq) => readJournalRow(database.db, sessionId, live, seq) ?? [])
}

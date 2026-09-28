// Republishing a live item set into a fresh epoch.
//
// One transaction: discard the old block, insert the epoch row plus the
// replacement items into a fresh one, move the session projection, and retire
// any repair marker — this republished history is exactly what the marker was
// holding out for. The pages the old rows held go back to the filesystem after
// the commit.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { clearJournalRepairMarker } from './journal-repair-marker'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { buildJournalItemRow, journalRowBase } from './journal-row-builders'
import {
  allocateJournalBlock,
  deleteJournalBlock,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionPointer
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'
import { assertJournalFence } from './journal-write-guards'

export type JournalReplacementItem = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  observedAt?: number
}

export function replaceJournalEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  reason: AgentJournalEpochReason
  fence: number
  items: readonly JournalReplacementItem[]
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
      ts: item.observedAt ?? input.now()
    })
    assertJournalFence(row.fence, state.highestFence)
    applyJournalRow(state, row)
    rows.push(row)
  }

  const { sessionId } = input.identity
  const block = input.database.transaction((db) => {
    const retired = readJournalSessionPointer(db, sessionId)
    const fresh = allocateJournalBlock(db)
    if (retired) {
      deleteJournalBlock(db, retired.block)
    }
    clearJournalRepairMarker(db, sessionId)
    for (const row of rows) {
      insertJournalRow(db, fresh, row)
    }
    publishJournalSessionEpoch(db, input.identity, { epoch, block: fresh })
    return fresh
  })

  // COMMIT landed: on disk the superseded rows are gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // live store writing into an epoch whose rows were just deleted.
  state.oldestSequence = 1
  input.onPublished({ state, block, readOnly: false, corrupt: false, malformedRows: 0 })
  void input.database.reclaimFreePages()
}

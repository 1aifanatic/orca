// Opening a new epoch.
//
// One transaction: discard the superseded epoch's block, insert the new epoch
// row at sequence 1 of a fresh block, move the session projection onto it, and
// retire any repair marker the superseded epoch was carrying. Superseded rows
// are DELETED rather than retained — nothing would ever shed them — and the
// pages they held go back to the filesystem after the commit.

import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { clearJournalRepairMarker } from './journal-repair-marker'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  allocateJournalBlock,
  deleteJournalBlock,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionPointer
} from './journal-row-table'
import type { AgentJournalEpochReason, JournalRow } from './journal-row-schema'

export function publishNewEpoch(input: {
  database: JournalHostDatabase
  identity: AgentSessionJournalIdentity
  epoch: string
  reason: AgentJournalEpochReason
  fence: number
  now: number
  /** Called the instant the transaction commits, before any fallible follow-up. */
  onPublished: (loaded: JournalLoad) => void
}): void {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: input.identity.providerHandle,
    // Carries no body: an older host must keep reading a turn-free session past row 1.
    v: journalRowSchemaVersion([]),
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }

  const { sessionId } = input.identity
  const block = input.database.transaction((db) => {
    const retired = readJournalSessionPointer(db, sessionId)
    const fresh = allocateJournalBlock(db)
    if (retired) {
      deleteJournalBlock(db, retired.block)
    }
    clearJournalRepairMarker(db, sessionId)
    insertJournalRow(db, fresh, row)
    publishJournalSessionEpoch(db, input.identity, { epoch: input.epoch, block: fresh })
    return fresh
  })

  // COMMIT landed: on disk the superseded prefix is gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // store writing into an epoch that no longer exists.
  const state = createJournalReducerState(sessionId, input.epoch)
  applyJournalRow(state, row)
  state.oldestSequence = 1
  input.onPublished({ state, block, readOnly: false, corrupt: false, malformedRows: 0 })
  void input.database.reclaimFreePages()
}

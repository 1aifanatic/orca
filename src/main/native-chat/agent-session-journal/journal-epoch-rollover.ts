// Opening a new epoch.
//
// One transaction: discard every row of the superseded epoch, insert the new
// epoch row at sequence 1, and move the session projection onto it. Superseded
// rows are DELETED rather than retained — nothing would ever shed them.

import type Database from '../../sqlite/sync-database'
import { journalRowSchemaVersion } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalLoad } from './journal-open'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import {
  deleteJournalEpochRows,
  insertJournalRow,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
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
  const loaded = input.database.transaction((db) => writeNewJournalEpoch(db, input))

  // COMMIT landed: on disk the superseded prefix is gone and this epoch is the
  // live one. The caller adopts that immediately, or a later failure leaves the
  // store writing into an epoch that no longer exists.
  input.onPublished(loaded)
}

/** Initializes an epoch inside the host transaction that founds its conversation. */
export function writeNewJournalEpoch(
  db: Database.Database,
  input: {
    identity: AgentSessionJournalIdentity
    epoch: string
    reason: AgentJournalEpochReason
    fence: number
    now: number
  }
): JournalLoad {
  const row: JournalRow = {
    kind: 'epoch',
    reason: input.reason,
    providerHandle: agentSessionJournalProviderHandle(input.identity),
    // Carries no body: an older host must keep reading a turn-free session past row 1.
    v: journalRowSchemaVersion([]),
    epoch: input.epoch,
    seq: 1,
    fence: input.fence,
    ts: input.now
  }

  const { sessionId } = input.identity
  const retired = readJournalSessionEpoch(db, sessionId)
  if (retired !== null) {
    deleteJournalEpochRows(db, sessionId, retired)
  }
  insertJournalRow(db, sessionId, row)
  publishJournalSessionEpoch(db, input.identity, input.epoch)

  const state = createJournalReducerState(input.identity.sessionId, input.epoch)
  applyJournalRow(state, row)
  state.oldestSequence = 1
  return { state, newer: null, damage: null }
}

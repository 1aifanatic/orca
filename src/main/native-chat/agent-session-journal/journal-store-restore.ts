// Bringing a store's in-memory state up from disk.
//
// Split out of the store for the same reason its collaborators were: this is the
// ORDERING between replay, suffix repair and disclosure, and none of it belongs
// to the store's public surface. Every step here reads or writes through the
// same host the collaborators use, so the store keeps the state and this owns
// the sequence.

import type { JournalEpochController } from './journal-epoch-controller'
import { replayJournal } from './journal-open'
import type { JournalStoreHost } from './journal-store-collaborators'
import { openJournalStoreState } from './journal-store-open'
import { deleteJournalRepairedSuffix } from './journal-repair-marker'
import { importPerSessionJournal } from './journal-per-session-import'

export function restoreJournalStore(
  host: JournalStoreHost,
  collaborators: { epochController: JournalEpochController }
): Promise<void> {
  return openJournalStoreState({
    legacyDirectory: host.legacyDirectory,
    replay: () => {
      // A per-chat file left by an earlier build is this chat's newest history: copied in first.
      importPerSessionJournal({
        database: host.database(),
        identity: host.identity,
        legacyDirectory: host.legacyDirectory
      })
      const loaded = replayJournal(host.database().db, host.identity.sessionId)
      host.setOpenedCorrupt(loaded?.corrupt ?? false)
      return loaded
    },
    deleteSuffix: (fromSeq, contentFrom) =>
      deleteJournalRepairedSuffix({
        database: host.database(),
        sessionId: host.identity.sessionId,
        epoch: host.state().epoch,
        fromSeq,
        contentFrom,
        now: host.now()
      }),
    start: () => collaborators.epochController.start('session_created', 0),
    // `unreconcilable_prefix` is the durable statement that this epoch exists
    // because a repair emptied one: replay reads it back and keeps asking for
    // provider history until the timeline is rebuilt or the session writes.
    publishRepairEpoch: () =>
      collaborators.epochController.start('unreconcilable_prefix', host.state().highestFence),
    adopt: host.adopt,
    appendItem: (identity, body, fence) => host.journal().appendItem(identity, body, { fence }),
    agent: host.identity.agent,
    highestFence: () => host.state().highestFence,
    malformedRows: host.malformedRows,
    setMalformedRows: host.setMalformedRows,
    readOnly: host.readOnly
  })
}

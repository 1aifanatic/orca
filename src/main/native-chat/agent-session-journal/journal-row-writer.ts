import { insertJournalRow } from './journal-row-table'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { assertJournalFence, assertJournalWritable } from './journal-write-guards'

export type JournalRowWriterDeps = {
  sessionId: string
  now: () => number
  serialize: <T>(run: () => Promise<T>) => Promise<T>
  database: () => JournalHostDatabase
  readOnly: () => boolean
  highestFence: () => number
  nextSequence: () => number
  commit: (row: JournalRow) => void
}

export class JournalRowWriter {
  constructor(private readonly deps: JournalRowWriterDeps) {}

  enqueue(build: (seq: number, ts: number) => JournalRow): Promise<JournalRow> {
    return this.deps.serialize(async () => {
      assertJournalWritable(this.deps.readOnly(), this.deps.sessionId)
      const row = build(this.deps.nextSequence(), this.deps.now())
      assertJournalFence(row.fence, this.deps.highestFence())
      // One INSERT: the chat's epoch pointer moves only when the epoch does.
      this.deps.database().transaction((db) => insertJournalRow(db, this.deps.sessionId, row))
      // COMMIT landed, so the row is durable: adopt it before anything that can
      // fail. Rejecting here instead would leave the next append reusing a
      // sequence the table already holds.
      this.deps.commit(row)
      return row
    })
  }
}

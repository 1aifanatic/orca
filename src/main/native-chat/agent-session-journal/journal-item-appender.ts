import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalReducerState } from './journal-reducer'
import type { JournalAppendResult, JournalItemAppendOptions } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'

export class JournalItemAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
    }
  ) {}

  append(
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: JournalItemAppendOptions,
    /** Runs inside the serialized build, before the row is applied. */
    beforeBuild?: () => void
  ): Promise<JournalAppendResult> {
    const itemId = agentJournalItemKey(identity)
    const build = journalItemRowBuilder(this.deps.state, identity, body, options)
    return this.deps
      .enqueue((seq, ts) => {
        beforeBuild?.()
        return build(seq, ts)
      })
      .then((row) => ({
        cursor: { epoch: row.epoch, sequence: row.seq },
        itemId,
        revision: (row as Extract<JournalRow, { kind: 'item' }>).revision
      }))
  }
}

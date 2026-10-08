import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session-journal-producer'
import type { JournalReducerState } from './journal-reducer'
import type { JournalItemRow } from './journal-row-schema'
import { journalRowBase } from './journal-row-base'
import { turnEndAfterStop } from './journal-stop-turn-end'

export function buildJournalItemRow(input: {
  state: JournalReducerState
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  seq: number
  fence: number
  ts: number
  recovered?: true
  providerObservedAt?: number
  linkage?: AgentJournalProducerLinkage
  turnScope: AgentJournalTurnScope
}): JournalItemRow {
  const itemId = agentJournalItemKey(input.identity)
  const resolved = input.state.aliases.get(itemId) ?? itemId
  // A tombstoned row keeps its revision in `tombstones`, and the reducer drops
  // any item at or below it — so a re-add has to outrank the tombstone too.
  const revision =
    Math.max(
      input.state.items.get(resolved)?.revision ?? 0,
      input.state.tombstones.get(resolved) ?? 0
    ) + 1
  const body = turnEndAfterStop(input.state, resolved, input.body)
  return {
    kind: 'item',
    itemId,
    revision,
    body,
    ...journalRowBase(input.state.epoch, input.seq, input.fence, input.ts, [body]),
    ...(input.recovered ? { recovered: input.recovered } : {}),
    ...(input.providerObservedAt === undefined
      ? {}
      : { providerObservedAt: input.providerObservedAt }),
    turnScope: input.turnScope,
    ...agentJournalLinkageFields(input.linkage)
  }
}

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from './agent-session-history-page-bounds'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'

/** Reconnect refreshes derived bodies whose durable revision has not changed. */
export function refreshDerivedJournalItems(
  port: Pick<SubscriberDeliveryPort, 'emit' | 'isActive'>,
  subscriber: Subscriber,
  journal: AgentSessionJournal,
  hostNow: number
): void {
  let hasDerivedItem = false
  journal.visitItems((itemId, _sequence, body) => {
    if (
      journal.isReopenedLiveWorkItem(itemId) ||
      (body.kind === 'status' &&
        body.failure?.kind === 'cancelUnconfirmed' &&
        isStructuredAgentSessionStopNote(itemId))
    ) {
      hasDerivedItem = true
    }
  })
  if (!hasDerivedItem) {
    return
  }
  const snapshot = journal.snapshot()
  let pending: AgentJournalRenderItem[] = []
  let bytes = 0
  const emit = (): void => {
    port.emit(subscriber, {
      type: 'batch',
      sessionId: subscriber.sessionId,
      batch: { ...emptyAgentSessionBatch(subscriber.cursor), items: pending },
      fence: subscriber.fence,
      hostNow
    })
    pending = []
    bytes = 0
  }
  for (const item of snapshot.items) {
    if (!port.isActive(subscriber)) {
      return
    }
    const raw = journal.itemBody(item.itemId)
    if (
      !journal.isReopenedLiveWorkItem(item.itemId) &&
      (raw?.kind !== 'status' ||
        raw.failure?.kind !== 'cancelUnconfirmed' ||
        item.body.kind !== 'status' ||
        item.body.failure !== undefined)
    ) {
      continue
    }
    const projectedBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
    const bounded =
      projectedBytes > HISTORY_PAGE_CONTENT_BUDGET_BYTES ? oversizedHistoryItem(item) : item
    const itemBytes = Buffer.byteLength(JSON.stringify(bounded), 'utf8') + 1
    if (
      pending.length > 0 &&
      (pending.length === AGENT_SESSION_HISTORY_MAX_LIMIT ||
        bytes + itemBytes > HISTORY_PAGE_CONTENT_BUDGET_BYTES)
    ) {
      emit()
    }
    pending.push(bounded)
    bytes += itemBytes
  }
  if (pending.length > 0 && port.isActive(subscriber)) {
    emit()
  }
}

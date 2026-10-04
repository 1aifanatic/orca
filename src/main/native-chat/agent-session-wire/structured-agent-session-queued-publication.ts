// The published view of a conversation's queue: its whole draft list, the queue's
// pause and the card it sends next, on the `commands` precedent — read per emit,
// reference-stable while unchanged, so the subscribers' identity dedup keeps token
// streams from re-sending it. They ride together: a client never sees one without the others.

import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  queuePauseHolding,
  resumableQueuePause,
  type DerivedQueuePause
} from '../agent-session-journal/queued-message-pause'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { nextStructuredQueuedMessage } from './structured-agent-session-queued-messages'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export type QueuePublication = {
  queuedMessages: AgentSessionQueuedMessage[]
  queuePause: AgentSessionQueuePause | null
  /** The card the drain sends next as soon as nothing runs (`nextStructuredQueuedMessage`), so a
   *  client reads the run as going across a turn's end and that send, which commit apart. */
  nextQueuedMessageId: string | null
}

/** What the drain's gate reads beyond the journal; resolved per read. */
export type QueueSendGate = () => { record: AgentSessionRecord | null; fence: number }

export function structuredQueueSendGate(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  sessionId: string
): QueueSendGate {
  return () => ({
    record: store.getRecord(sessionId),
    fence: structuredAgentSessionConversationFence(store, sessionId)
  })
}

/** Waiting and returned rows only. `paused` is a per-card hold (a failed
 *  conversion); `heldBy` names the queue-level pause holding the card, if any. */
function computePublishedQueuedMessages(
  journal: AgentSessionJournal,
  pauses: readonly DerivedQueuePause[]
): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of journal.queuedMessages.list()) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    const held = row.state === 'waiting' && row.holdReason !== null
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(held ? { paused: true as const } : {}),
      // The stored reason is a typed marker; an unknown one reads as a plain hold.
      ...(held && row.holdReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
        ? { pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
        : {}),
      heldBy: heldBy(pauses, row),
      ...(row.state === 'returned' ? { returnedReason: row.returnedReason } : {}),
      ...(row.state === 'returned' && row.returnedRejection
        ? { returnedRejection: row.returnedRejection }
        : {})
    })
  }
  return published
}

function heldBy(
  pauses: readonly DerivedQueuePause[],
  row: Parameters<typeof queuePauseHolding>[1]
): AgentSessionQueuePause | null {
  const holding = queuePauseHolding(pauses, row)
  return holding ? { reason: holding.reason } : null
}

type ListMemo = { key: string; serialized: string; list: AgentSessionQueuedMessage[] }

/** Reference-stable per journal handle: an unchanged list is never
 *  re-serialized onto token-stream frames, and any draft-table write or change
 *  of the pauses in force changes the reference by construction. */
const listMemos = new WeakMap<AgentSessionJournal, ListMemo>()
const publications = new WeakMap<AgentSessionJournal, QueuePublication>()

function readPublishedQueuedMessages(
  journal: AgentSessionJournal,
  pauses: readonly DerivedQueuePause[]
): AgentSessionQueuedMessage[] {
  // The pauses also turn on journal rows (a Stop, a person's turn), not only on the drafts.
  const key = `${journal.queuedMessages.revision()}:${JSON.stringify(pauses)}`
  const memo = listMemos.get(journal)
  if (memo && memo.key === key) {
    return memo.list
  }
  const list = computePublishedQueuedMessages(journal, pauses)
  // Belt for the identity dedup: equal recomputed content keeps the previous reference.
  const serialized = JSON.stringify(list)
  if (memo && memo.serialized === serialized) {
    listMemos.set(journal, { key, serialized, list: memo.list })
    return memo.list
  }
  listMemos.set(journal, { key, serialized, list })
  return list
}

/** Presence first: a pause appearing or clearing is a change even when neither side
 *  names a reason this build can read. */
export function sameQueuePause(
  previous: { reason?: string } | null,
  next: { reason?: string } | null
): boolean {
  return (previous === null) === (next === null) && previous?.reason === next?.reason
}

export function readQueuePublication(
  journal: AgentSessionJournal,
  gate: QueueSendGate
): QueuePublication {
  // Read per emit: the pauses also turn on submissions (a person's turn starting).
  const pauses = structuredQueuePauses(journal)
  const queuedMessages = readPublishedQueuedMessages(journal, pauses)
  // Shown only over a card Resume would send, so a header never offers to send nothing;
  // deleting a blocking returned card shows it again.
  const pause = resumableQueuePause(pauses, journal.queuedMessages.list())
  const queuePause = pause ? { reason: pause.reason } : null
  const nextQueuedMessageId = nextStructuredQueuedMessage({ journal, ...gate() })?.messageId ?? null
  const previous = publications.get(journal)
  if (
    previous &&
    previous.queuedMessages === queuedMessages &&
    sameQueuePause(previous.queuePause, queuePause) &&
    previous.nextQueuedMessageId === nextQueuedMessageId
  ) {
    return previous
  }
  const publication = { queuedMessages, queuePause, nextQueuedMessageId }
  publications.set(journal, publication)
  return publication
}

/** For readers that must never fail on drafts — a subscriber stream, a history
 *  page: a closing handle answers "no claim" (absent) instead of throwing. */
export function tryReadQueuePublication(
  journal: AgentSessionJournal | undefined,
  gate: QueueSendGate
): QueuePublication | undefined {
  try {
    return journal ? readQueuePublication(journal, gate) : undefined
  } catch {
    return undefined
  }
}

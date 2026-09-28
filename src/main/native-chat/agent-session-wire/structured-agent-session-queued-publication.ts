// The published whole-list view of a conversation's queued drafts, on the
// `commands` precedent: read per emit, reference-stable while unchanged, so the
// subscribers' identity dedup keeps token streams from re-sending it.

import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  QUEUED_MESSAGE_PAUSED_STOPPED,
  type AgentSessionQueuedMessage
} from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  queuedMessageHeld,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'

/** The published whole-list view: waiting and returned rows only, with `paused`
 *  derived at publish time from the stored hold and the host instance. */
function computePublishedQueuedMessages(journal: AgentSessionJournal): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of journal.queuedMessages.list()) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    const paused = row.state === 'waiting' && queuedMessageHeld(row)
    // The stored reason is a typed marker; an unknown one reads as a plain
    // hold. A held row with NO stored reason is the derived restart hold,
    // which lifts exactly like a Stop's — so it publishes as 'stopped'.
    const pausedReason = !paused
      ? undefined
      : row.holdReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
        ? QUEUED_MESSAGE_PAUSED_SEND_FAILED
        : row.holdReason === QUEUED_MESSAGE_PAUSED_STOPPED || row.holdReason === null
          ? QUEUED_MESSAGE_PAUSED_STOPPED
          : undefined
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(paused ? { paused: true as const } : {}),
      ...(pausedReason !== undefined ? { pausedReason } : {}),
      ...(row.state === 'returned' ? { returnedReason: row.returnedReason } : {})
    })
  }
  return published
}

type PublicationMemo = { key: string; serialized: string; list: AgentSessionQueuedMessage[] }

/** Reference-stable per journal handle: an unchanged list is never re-serialized
 *  onto token-stream frames, and any draft-table write — holds and the returned
 *  transition included — changes the reference by construction. */
const publicationMemos = new WeakMap<AgentSessionJournal, PublicationMemo>()

export function readPublishedQueuedMessages(
  journal: AgentSessionJournal
): AgentSessionQueuedMessage[] {
  // The instance id joins the key so a restart (or its test rotation) re-derives
  // the held flags; within one process it never changes.
  const key = `${journal.queuedMessages.revision()}:${structuredAgentSessionHostInstance()}`
  const memo = publicationMemos.get(journal)
  if (memo && memo.key === key) {
    return memo.list
  }
  const list = computePublishedQueuedMessages(journal)
  // Belt for the identity dedup: recomputed content that is structurally equal
  // keeps the previous reference, so subscribers do not re-send an equal list.
  const serialized = JSON.stringify(list)
  if (memo && memo.serialized === serialized) {
    publicationMemos.set(journal, { key, serialized, list: memo.list })
    return memo.list
  }
  publicationMemos.set(journal, { key, serialized, list })
  return list
}

/** For readers that must never fail on drafts — a subscriber stream, a history
 *  page: a closing handle answers "no claim" (absent) instead of throwing. */
export function tryReadPublishedQueuedMessages(
  journal: AgentSessionJournal | undefined
): AgentSessionQueuedMessage[] | undefined {
  try {
    return journal ? readPublishedQueuedMessages(journal) : undefined
  } catch {
    return undefined
  }
}

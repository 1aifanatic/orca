// The published whole-list view of a conversation's queued drafts, on the
// `commands` precedent: read per emit, reference-stable while unchanged, so the
// subscribers' identity dedup keeps token streams from re-sending it.

import type { AgentSessionQueuedMessage } from '../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  queuedMessageHeld,
  queuedMessagePause,
  queuedMessagePauseRevision
} from './structured-agent-session-queued-pause'

/** The published whole-list view: waiting and returned rows only, with `paused`
 *  derived at publish time from the process pause set and the host instance. */
function computePublishedQueuedMessages(journal: AgentSessionJournal): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of journal.queuedMessages.list()) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    const pause = queuedMessagePause(row.sessionId, row.messageId)
    const paused = row.state === 'waiting' && queuedMessageHeld(row)
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(paused ? { paused: true as const } : {}),
      ...(paused && pause?.reason !== undefined ? { pausedReason: pause.reason } : {}),
      ...(row.state === 'returned' ? { returnedReason: row.returnedReason } : {})
    })
  }
  return published
}

type PublicationMemo = { key: string; serialized: string; list: AgentSessionQueuedMessage[] }

/** Reference-stable per journal handle: an unchanged list is never re-serialized
 *  onto token-stream frames, and any draft-table write — the returned transition
 *  included — changes the reference by construction. */
const publicationMemos = new WeakMap<AgentSessionJournal, PublicationMemo>()

export function readPublishedQueuedMessages(
  journal: AgentSessionJournal
): AgentSessionQueuedMessage[] {
  const key = `${journal.queuedMessages.revision()}:${queuedMessagePauseRevision()}`
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

// Tells a composer when the host has a message it sent for good, so the chat's saved draft can stop
// holding it: the host handed it to the agent, the agent accepted it, or the host queued it as a
// card (all kept across quit and restart), by the send's reply or the journal.
// A message withdrawn back into the box, or dropped, also settles; one refused, rejected or still
// unconfirmed keeps its draft copy until it is delivered or leaves. A refusal that gives the entry
// a new id is followed to that id.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

type Watched = { queuedAt: number; body: string }
type Watcher = { messages: Map<string, Watched>; settle: () => void }

const watchersBySession = new Map<string, Set<Watcher>>()

function forEachWatcher(sessionId: string, visit: (watcher: Watcher) => void): void {
  const watchers = watchersBySession.get(sessionId)
  if (!watchers) {
    return
  }
  for (const watcher of Array.from(watchers)) {
    visit(watcher)
    if (watcher.messages.size === 0) {
      watchers.delete(watcher)
      watcher.settle()
    }
  }
  if (watchers.size === 0) {
    watchersBySession.delete(sessionId)
  }
}

/**
 * Whether the host holds a submission past quit and restart: the agent accepted it, or the host
 * handed it over. One it accepted but has not handed over yet is rejected when Orca quits, and
 * after a crash when the chat next opens, so its draft copy must stay until then.
 */
export function structuredAgentSessionSubmissionHeldForGood(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'handoverRecorded' | 'handedOverAt'>
): boolean {
  return (
    submission.dispatchState === 'accepted' ||
    (submission.dispatchState === 'pending' && !isQueuedAgentJournalSubmission(submission))
  )
}

/** Settles once the host has every one of `entries` (or each was withdrawn or dropped). */
export function whenStructuredAgentSessionHostHasMessages(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): Promise<void> {
  if (entries.length === 0) {
    return Promise.resolve()
  }
  return new Promise((settle) => {
    const messages = new Map(
      entries.map((entry): [string, Watched] => [
        entry.clientMessageId,
        { queuedAt: entry.queuedAt, body: JSON.stringify(entry.body) }
      ])
    )
    const watchers = watchersBySession.get(sessionId) ?? new Set()
    watchersBySession.set(sessionId, watchers)
    watchers.add({ messages, settle })
  })
}

/** The host answered these sends ok, or its journal shows them. */
export function noteStructuredAgentSessionMessagesDelivered(
  sessionId: string,
  clientMessageIds: Iterable<string>
): void {
  const delivered = new Set(clientMessageIds)
  forEachWatcher(sessionId, (watcher) => {
    for (const id of delivered) {
      watcher.messages.delete(id)
    }
  })
}

/** A message left the outbox undelivered: its draft copy is the only one, so nothing saves over it. */
export function keepStructuredAgentSessionMessageDraft(
  sessionId: string,
  clientMessageId: string
): void {
  const watchers = watchersBySession.get(sessionId)
  for (const watcher of Array.from(watchers ?? [])) {
    if (watcher.messages.has(clientMessageId)) {
      watchers?.delete(watcher)
    }
  }
}

/** Every outbox write: a watched entry that left settles, unless it only took a new id. */
export function observeStructuredAgentSessionOutboxWrite(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[]
): void {
  const present = new Set(entries.map((entry) => entry.clientMessageId))
  forEachWatcher(sessionId, (watcher) => {
    for (const [id, watched] of Array.from(watcher.messages)) {
      if (present.has(id)) {
        continue
      }
      watcher.messages.delete(id)
      const renamed = entries.find(
        (entry) =>
          !watcher.messages.has(entry.clientMessageId) &&
          entry.queuedAt === watched.queuedAt &&
          JSON.stringify(entry.body) === watched.body
      )
      if (renamed) {
        watcher.messages.set(renamed.clientMessageId, watched)
      }
    }
  })
}

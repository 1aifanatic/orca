// How each outbox entry finally ended, for whoever waits on one (a launch prompt's caller, the
// notes it carries): the host holds it, or it left without reaching the host. A send with no answer
// yet has not ended; the open chat keeps sending it under its id.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

export type StructuredAgentSessionEntryEnding = 'delivered' | 'notDelivered'

type Watcher = (ending: StructuredAgentSessionEntryEnding) => void
type EndedEntry = Pick<
  StructuredAgentSessionOutboxEntry,
  'sessionId' | 'clientMessageId' | 'carriedNoteKeys'
>

const watchers = new Map<string, Map<string, Set<Watcher>>>()
const deliveredListeners = new Set<(entry: EndedEntry) => void>()

/** Told every entry the host took, from any window's send or the journal, reload included. */
export function subscribeToStructuredAgentSessionEntriesDelivered(
  listener: (entry: EndedEntry) => void
): () => void {
  deliveredListeners.add(listener)
  return () => deliveredListeners.delete(listener)
}

/** Says how an entry ended to everyone watching it. Run before the outbox that drops it is
 *  committed, so what it carries is settled before anything reads the outbox without it. */
export function endStructuredAgentSessionEntry(
  entry: EndedEntry,
  ending: StructuredAgentSessionEntryEnding
): void {
  if (ending === 'delivered') {
    for (const listener of deliveredListeners) {
      listener(entry)
    }
  }
  const { clientMessageId, sessionId } = entry
  const session = watchers.get(sessionId)
  const watching = session?.get(clientMessageId)
  if (!session || !watching) {
    return
  }
  session.delete(clientMessageId)
  if (session.size === 0) {
    watchers.delete(sessionId)
  }
  for (const watcher of watching) {
    watcher(ending)
  }
}

/** An outbox committed without a watched entry: it left without a settlement saying how (a Stop
 *  took it back, a closed chat discarded it), so it was not delivered. */
export function noteStructuredAgentSessionOutboxCommitted(
  sessionId: string,
  entries: readonly { clientMessageId: string }[]
): void {
  const session = watchers.get(sessionId)
  if (!session) {
    return
  }
  for (const clientMessageId of session.keys()) {
    if (!entries.some((entry) => entry.clientMessageId === clientMessageId)) {
      endStructuredAgentSessionEntry({ sessionId, clientMessageId }, 'notDelivered')
    }
  }
}

/** Watches one entry until it ends. Watch before sending, so an answer that settles at once is
 *  not missed; `cancel` when the ending is no longer wanted. */
export function watchStructuredAgentSessionEntryEnding(
  sessionId: string,
  clientMessageId: string
): {
  ending: Promise<StructuredAgentSessionEntryEnding>
  /** How it ended, if it already has. */
  endedAs: () => StructuredAgentSessionEntryEnding | null
  cancel: () => void
} {
  const ended = Promise.withResolvers<StructuredAgentSessionEntryEnding>()
  let endedAs: StructuredAgentSessionEntryEnding | null = null
  const watcher: Watcher = (ending) => {
    endedAs = ending
    ended.resolve(ending)
  }
  const session = watchers.get(sessionId) ?? new Map<string, Set<Watcher>>()
  watchers.set(sessionId, session)
  const watching = session.get(clientMessageId) ?? new Set<Watcher>()
  session.set(clientMessageId, watching)
  watching.add(watcher)
  return {
    ending: ended.promise,
    endedAs: () => endedAs,
    cancel: () => {
      watching.delete(watcher)
      if (watching.size === 0 && session.get(clientMessageId) === watching) {
        session.delete(clientMessageId)
      }
      if (session.size === 0 && watchers.get(sessionId) === session) {
        watchers.delete(sessionId)
      }
    }
  }
}

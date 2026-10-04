// How each outbox entry finally ended, for whoever waits on one (a launch prompt's caller, the
// notes it carries): the host holds it; its text went back to the composer; or it was thrown away
// with nothing handed back. A send with no answer yet has not ended; the open chat keeps sending it.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'

export type StructuredAgentSessionEntryEnding =
  | 'delivered'
  /** Returned or withdrawn: the composer's draft holds the text now. */
  | 'returned'
  /** Gone with nothing handed back: a cancelled launch, or a chat this window closed. */
  | 'discarded'

type Watcher = (ending: StructuredAgentSessionEntryEnding) => void
type EndedEntry = Pick<
  StructuredAgentSessionOutboxEntry,
  'sessionId' | 'clientMessageId' | 'carriedNoteKeys'
>

const watchers = new Map<string, Map<string, Set<Watcher>>>()
const endingListeners = new Set<
  (entry: EndedEntry, ending: StructuredAgentSessionEntryEnding) => void
>()

/** Told how every entry ended, from any send, the journal or a Stop, reload included. */
export function subscribeToStructuredAgentSessionEntryEndings(
  listener: (entry: EndedEntry, ending: StructuredAgentSessionEntryEnding) => void
): () => void {
  endingListeners.add(listener)
  return () => endingListeners.delete(listener)
}

/** Says how an entry ended to everyone watching it. Run before the outbox that drops it is
 *  committed, so what it carries is settled before anything reads the outbox without it. */
export function endStructuredAgentSessionEntry(
  entry: EndedEntry,
  ending: StructuredAgentSessionEntryEnding
): void {
  for (const listener of endingListeners) {
    listener(entry, ending)
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

/** An outbox committed without a watched entry: it left without a settlement or a Stop saying how
 *  (a closed chat discarded it), so it was thrown away. */
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
      endStructuredAgentSessionEntry({ sessionId, clientMessageId }, 'discarded')
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

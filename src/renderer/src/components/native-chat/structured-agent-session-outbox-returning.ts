// A message handed back to its conversation's draft stays in the outbox, marked returning, until
// the draft holds it durably (the addition journaled at once, or storage confirming the draft), and
// only then leaves and says it ended (which clears the notes it carried). Drafts are saved
// asynchronously, so removing the copy first could lose the text in a crash. A returning entry is
// never sent again: its id proved no record, so a resend would be a new first send. On load, one
// still marked re-runs its hand-back, which the shared returned-text rule and image id check make
// safe to repeat. A refused save keeps it until a later save of that draft lands in this run, or
// the next load.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  hydrateNativeChatComposerDrafts,
  isNativeChatComposerDraftLoadPending,
  isNativeChatComposerDraftUnsaved,
  nativeChatComposerDraftWriteSettled,
  structuredAgentSessionDraftScopeKey,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox,
  savedStructuredAgentSessionOutboxes
} from './structured-agent-session-outbox-storage'
import { endStructuredAgentSessionEntry } from './structured-agent-session-entry-endings'
import { returnStructuredAgentSessionMessage } from './structured-agent-session-returned-send'

/** The entry kept while its text goes back to the draft, ending as `ending` once that is saved. */
export function returningStructuredAgentSessionEntry(
  entry: StructuredAgentSessionOutboxEntry,
  ending: 'returned' | 'discarded'
): StructuredAgentSessionOutboxEntry {
  return { ...entry, returning: { ending } }
}

/** Whether storage holds the scope's draft as written so far: false when it refused it. */
function structuredAgentSessionDraftSaved(scopeKey: string): Promise<boolean> {
  return nativeChatComposerDraftWriteSettled(scopeKey)
}

/** How often a hand-back looks again for the startup load of saved drafts; a failed load retries
 *  on its own timer, so this only waits, never spins. */
const LOAD_RECHECK_MS = 200

/** Resolves once the saved drafts are in memory (or their load was given up): a hand-back reads
 *  the draft it adds to, and an addition made before the load is applied again to the loaded one. */
async function draftsLoaded(): Promise<void> {
  while (isNativeChatComposerDraftLoadPending()) {
    await Promise.race([
      hydrateNativeChatComposerDrafts(),
      new Promise((resolve) => setTimeout(resolve, LOAD_RECHECK_MS))
    ])
    if (isNativeChatComposerDraftLoadPending()) {
      await new Promise((resolve) => setTimeout(resolve, LOAD_RECHECK_MS))
    }
  }
}

/** Resolves when the scope's draft next reads as saved after a change: the user's own edit or send,
 *  or a retried write, landing. */
function nextDraftSave(scopeKey: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = subscribeToNativeChatComposerDraft(scopeKey, () => {
      if (!isNativeChatComposerDraftUnsaved(scopeKey)) {
        unsubscribe()
        resolve()
      }
    })
  })
}

/** Waits until storage holds the scope's draft. A refused save is checked again when a later save
 *  of that draft lands, in this run: by then the user has the text, as typed, edited or sent. */
async function draftSavedInThisRun(scopeKey: string): Promise<void> {
  while (!(await structuredAgentSessionDraftSaved(scopeKey))) {
    await nextDraftSave(scopeKey)
  }
}

const handingBack = new Set<string>()

/**
 * Puts a returning entry's text and images in its draft and, once storage has them, removes the
 * entry and ends it. Its returning mark is committed first, so a crash in between re-runs this on
 * load instead of sending it again.
 */
export function handBackStructuredAgentSessionEntry(
  entry: StructuredAgentSessionOutboxEntry
): void {
  const key = JSON.stringify([entry.sessionId, entry.clientMessageId])
  if (handingBack.has(key)) {
    return
  }
  handingBack.add(key)
  const handBack = (): void => {
    // Durable at once (journaled) lets it go now; otherwise the draft's confirmed write does.
    if (returnStructuredAgentSessionMessage(entry)) {
      handingBack.delete(key)
      finishReturning(entry)
      return
    }
    void draftSavedInThisRun(structuredAgentSessionDraftScopeKey(entry.sessionId))
      .then(() => finishReturning(entry))
      .finally(() => handingBack.delete(key))
  }
  // Read against the loaded drafts. A hand-back can run before the app starts their load (child
  // effects run before App's), so it starts the load itself; until that lands it waits.
  void hydrateNativeChatComposerDrafts()
  if (isNativeChatComposerDraftLoadPending()) {
    void draftsLoaded().then(handBack, () => handingBack.delete(key))
  } else {
    handBack()
  }
}

function finishReturning(entry: StructuredAgentSessionOutboxEntry): void {
  const current = getStructuredAgentSessionOutbox(entry.sessionId)
  const held = current.find((candidate) => candidate.clientMessageId === entry.clientMessageId)
  if (!held?.returning) {
    return
  }
  // Ended before the outbox without it is committed, so its notes are settled first.
  endStructuredAgentSessionEntry(held, held.returning.ending)
  commitStructuredAgentSessionOutbox(
    entry.sessionId,
    current.filter((candidate) => candidate !== held)
  )
}

/** Commits a Stop's local step: what it withdrew stays, marked returning, in its place until the
 *  draft holds its text; the rest as the Stop left it. Returns the withdrawn entries. */
export function commitStructuredAgentSessionWithdrawals(
  sessionId: string,
  current: readonly StructuredAgentSessionOutboxEntry[],
  stopped: {
    entries: readonly StructuredAgentSessionOutboxEntry[]
    withdrawn: readonly StructuredAgentSessionOutboxEntry[]
  }
): StructuredAgentSessionOutboxEntry[] {
  const withdrawn = new Map(
    stopped.withdrawn.map((entry) => [
      entry.clientMessageId,
      returningStructuredAgentSessionEntry(entry, 'returned')
    ])
  )
  const kept = new Map(stopped.entries.map((entry) => [entry.clientMessageId, entry]))
  commitStructuredAgentSessionOutbox(
    sessionId,
    current.flatMap((entry) => {
      const after = withdrawn.get(entry.clientMessageId) ?? kept.get(entry.clientMessageId)
      return after ? [after] : []
    })
  )
  for (const entry of withdrawn.values()) {
    handBackStructuredAgentSessionEntry(entry)
  }
  return [...withdrawn.values()]
}

/** Finishes every hand-back a previous run left before its draft was saved. */
export function resumeReturningStructuredAgentSessionEntries(): void {
  for (const [, entries] of savedStructuredAgentSessionOutboxes()) {
    for (const entry of entries) {
      if (entry.returning) {
        handBackStructuredAgentSessionEntry(entry)
      }
    }
  }
}

export function resetReturningStructuredAgentSessionEntriesForTests(): void {
  handingBack.clear()
}

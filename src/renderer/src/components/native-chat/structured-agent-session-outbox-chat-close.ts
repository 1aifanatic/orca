// What closing a chat does to its outbox: it never throws away a message the person sent. A
// cancelled launch's own prompt, never sent, goes with the launch. Any other message that never
// went out comes back to the conversation's draft, kept marked returning until that draft is saved;
// its notes follow the text, except for a cancelled launch, whose draft no chat shows, so they go
// back on the shelf. One that went out may be the host's, so it stays and settles when the chat is
// reopened.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from '../../../../shared/structured-agent-session-outbox-admission'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import {
  handBackStructuredAgentSessionEntry,
  returningStructuredAgentSessionEntry
} from './structured-agent-session-outbox-returning'

function neverWentOut(entry: StructuredAgentSessionOutboxEntry): boolean {
  return (
    entry.lastAttemptAt === null &&
    !structuredAgentSessionEntryAwaitsSettlement(entry) &&
    entry.returning === undefined
  )
}

/** Settles a closing chat's outbox. `cancelledLaunch`: the chat is a launch that never published,
 *  whose own prompt goes with it. */
export function settleStructuredAgentSessionOutboxForClosedChat(
  sessionId: string,
  options: { cancelledLaunch: boolean }
): void {
  const current = getStructuredAgentSessionOutbox(sessionId)
  const returning: StructuredAgentSessionOutboxEntry[] = []
  const next = current.flatMap((entry) => {
    if (!neverWentOut(entry)) {
      return [entry]
    }
    if (options.cancelledLaunch && entry.source === 'launch') {
      return []
    }
    // A cancelled launch's notes come back, any other's are used, once the draft holds the text.
    const marked = returningStructuredAgentSessionEntry(
      entry,
      options.cancelledLaunch ? 'discarded' : 'returned'
    )
    returning.push(marked)
    return [marked]
  })
  if (next.some((entry, index) => entry !== current[index]) || next.length !== current.length) {
    // The cancelled launch's prompt ends as discarded here, putting its notes back.
    commitStructuredAgentSessionOutbox(sessionId, next)
  }
  for (const entry of returning) {
    handBackStructuredAgentSessionEntry(entry)
  }
}

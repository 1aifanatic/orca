// What closing a chat does to its outbox: it never throws away a message the person sent. A
// cancelled launch's own prompt, never sent, goes with the launch. Any other message that never
// went out comes back to the conversation's draft; its notes follow the text, except for a
// cancelled launch, whose draft no chat shows, so they go back on the shelf. One that went out may
// be the host's, so it stays and settles when the chat is reopened.

import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryAwaitsSettlement } from '../../../../shared/structured-agent-session-outbox-admission'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'
import { endStructuredAgentSessionEntry } from './structured-agent-session-entry-endings'
import { returnStructuredAgentSessionMessage } from './structured-agent-session-returned-send'

function neverWentOut(entry: StructuredAgentSessionOutboxEntry): boolean {
  return entry.lastAttemptAt === null && !structuredAgentSessionEntryAwaitsSettlement(entry)
}

/** Settles a closing chat's outbox. `cancelledLaunch`: the chat is a launch that never published,
 *  whose own prompt goes with it. */
export function settleStructuredAgentSessionOutboxForClosedChat(
  sessionId: string,
  options: { cancelledLaunch: boolean }
): void {
  const current = getStructuredAgentSessionOutbox(sessionId)
  const kept: StructuredAgentSessionOutboxEntry[] = []
  for (const entry of current) {
    if (!neverWentOut(entry)) {
      kept.push(entry)
    } else if (!(options.cancelledLaunch && entry.source === 'launch')) {
      // The draft holds the text first; a cancelled launch's notes come back, any other's are used.
      returnStructuredAgentSessionMessage(entry)
      endStructuredAgentSessionEntry(entry, options.cancelledLaunch ? 'discarded' : 'returned')
    }
  }
  if (kept.length !== current.length) {
    // The cancelled launch's prompt ends as discarded here, putting its notes back.
    commitStructuredAgentSessionOutbox(sessionId, kept)
  }
}

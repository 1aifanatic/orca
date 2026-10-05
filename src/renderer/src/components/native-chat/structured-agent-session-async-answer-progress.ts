// Where each structured async-question answer stands, read from the persisted outbox alone: an
// entry with a card origin covers its questions while it waits or goes out, and gives its
// answers back to the card once its delivery failed or is unconfirmed. Once the host has it the
// entry leaves, and the card waits only for the host's set to drop the question. A remount or a
// relaunch reads the same entries, so Send can't be re-enabled for an answer still on its way.

import type { NativeChatAsyncAnswerProgress } from '../../../../shared/native-chat-async-question-card-state'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { structuredAgentSessionEntryHeldForRetry } from '../../../../shared/structured-agent-session-outbox-admission'

function onItsWay(entry: StructuredAgentSessionOutboxEntry): boolean {
  if (entry.state === 'dispatching') {
    return true
  }
  // A held send or one a Stop outlived goes again only on the user's Retry.
  return (
    entry.state === 'queued' &&
    !structuredAgentSessionEntryHeldForRetry(entry) &&
    !entry.outlivedStop
  )
}

/** Oldest first, so the newest answer to a question decides it. */
export function structuredAsyncAnswerProgress(
  outbox: readonly StructuredAgentSessionOutboxEntry[]
): NativeChatAsyncAnswerProgress {
  const answers: Record<string, string> = {}
  const sendingKeys = new Set<string>()
  for (const entry of outbox) {
    if (entry.origin?.kind !== 'async-answer') {
      continue
    }
    const sending = onItsWay(entry)
    for (const [key, answer] of Object.entries(entry.origin.edits)) {
      answers[key] = answer
      if (sending) {
        sendingKeys.add(key)
      } else {
        sendingKeys.delete(key)
      }
    }
  }
  return { answers, sendingKeys }
}

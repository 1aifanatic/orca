// What a structured chat's own `check` reads around the mail its queue and sends carry. A consuming
// check takes the mail of the agent cards still in its queue (withdrawing them), so a chat waiting
// in one turn is never blocked by a card that sends only when that turn ends; it leaves out only
// mail a send already carries. A peek takes nothing. A terminal caller carries none.

import type { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import {
  markAcceptedChatMailRead,
  pendingChatMail,
  takeChatMail,
  withChatMailLock
} from '../../../../orchestration/structured-chat-mail'
import { structuredChatMailHost } from '../../../../orchestration/structured-mailbox-pointer-host'

export type QueuedChatMail = {
  /** What a peek leaves out: mail a send not settled yet carries. */
  peekExclusions: () => Promise<readonly string[]>
  /** A consuming read: takes the cards holding what `candidates` would read, then runs `read`
   *  with what it must still leave out, one at a time with the chat's delivery lane. */
  consume: <T>(
    candidates: (exclude: readonly string[]) => readonly string[],
    read: (exclude: readonly string[]) => T
  ) => T | Promise<T>
}

// Synchronous: a terminal's check reads and registers its waiter exactly as it always has.
const NO_QUEUED_CHAT_MAIL: QueuedChatMail = {
  peekExclusions: async () => [],
  consume: (_candidates, read) => read([])
}

export function queuedChatMailOf(
  db: OrchestrationDb,
  caller: OrchestrationSessionCaller | undefined
): QueuedChatMail {
  if (!caller) {
    return NO_QUEUED_CHAT_MAIL
  }
  const { sessionId } = caller
  const host = structuredChatMailHost
  return {
    peekExclusions: async () => {
      const mail = await host.readChatMail(sessionId)
      if (!mail) {
        return []
      }
      markAcceptedChatMailRead(db, mail)
      return pendingChatMail(mail)
    },
    consume: (candidates, read) =>
      withChatMailLock(sessionId, async () => {
        // Unreadable: leave nothing out; a duplicate beats hiding mail.
        const mail = await host.readChatMail(sessionId)
        return read(mail ? await takeChatMail({ db, sessionId, mail, host, candidates }) : [])
      })
  }
}

export function withoutQueuedChatMail<T extends { id: string }>(
  messages: T[],
  excluded: readonly string[]
): T[] {
  const skip = new Set(excluded)
  return skip.size === 0 ? messages : messages.filter((message) => !skip.has(message.id))
}

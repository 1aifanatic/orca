// Mail a structured chat's own queue already carries as an agent's card is on its way to it as a
// turn, so that chat's `check` leaves it out; deleting the card brings it back. Derived at read
// time from the queue; a terminal caller carries none.

import type { MessageRow } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { readQueuedChatMail } from '../../../../orchestration/structured-mailbox-pointer-host'

export type QueuedChatMail = () => Promise<readonly string[]>

const NO_QUEUED_CHAT_MAIL: QueuedChatMail = async () => []

export function queuedChatMailOf(caller: OrchestrationSessionCaller | undefined): QueuedChatMail {
  return caller ? () => readQueuedChatMail(caller.sessionId) : NO_QUEUED_CHAT_MAIL
}

export function withoutQueuedChatMail(
  messages: MessageRow[],
  queued: readonly string[]
): MessageRow[] {
  return queued.length === 0 ? messages : messages.filter((message) => !queued.includes(message.id))
}

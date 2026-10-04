/**
 * Who a mail notice sent to a chat speaks for: every distinct sender of the mail it points at,
 * named the way orchestration names a party, plus the records it stands for.
 *
 * A list rather than one sender: the notice counts a batch, and a batch can hold mail from several
 * agents. Each sender is a party a later reader can open; the run, dispatch and message ids join
 * back to orchestration's own rows while those exist.
 */

import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import type {
  AgentMessageSource,
  AgentMessageSender
} from '../../../shared/agent-session-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

export type PointerBatchMessage = Pick<
  MessageRow,
  'id' | 'type' | 'sequence' | 'from_handle' | 'run_id'
>

export function structuredPointerSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly PointerBatchMessage[]
}): AgentMessageSource {
  const senders = new Map<string, AgentMessageSender>()
  for (const message of input.batch) {
    if (!senders.has(message.from_handle)) {
      senders.set(message.from_handle, { party: senderParty(message, input.db) })
    }
  }
  return {
    kind: 'agent',
    senders: [...senders.values()],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      runIds: [...new Set(input.batch.map((message) => message.run_id))],
      messageIds: input.batch.map((message) => message.id)
    }
  }
}

function senderParty(
  message: PointerBatchMessage,
  db: OrchestrationDb | null
): AgentMessageSender['party'] {
  const address = message.from_handle
  try {
    const { paneKey: _credential, ...party } = resolveOrchestrationParty(address, db)
    return party
  } catch {
    // A worker this host lost the identity of: what the address itself says.
    return { address, terminalHandle: null, orcaSessionId: parseOrcaSessionAddress(address) }
  }
}

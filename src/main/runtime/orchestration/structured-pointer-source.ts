/**
 * Who a mail notice queued in a chat speaks for: every distinct sender of the mail it points at,
 * named the way orchestration names a party, plus the records it stands for.
 *
 * A list rather than one sender: the notice counts a batch, and a batch can hold mail from several
 * agents. Each sender is a party a later reader can open; the run, dispatch and message ids join
 * back to orchestration's own rows while those exist.
 */

import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import type { OrchestrationPartyIdentity } from '../../../shared/orchestration-party-identity'
import type {
  QueuedMessageAgentSource,
  QueuedMessageSender
} from '../../../shared/queued-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

export type PointerBatchMessage = Pick<
  MessageRow,
  'id' | 'type' | 'sequence' | 'from_handle' | 'sender_pane_key' | 'run_id'
>

export function structuredPointerSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly PointerBatchMessage[]
}): QueuedMessageAgentSource {
  const senders = new Map<string, QueuedMessageSender>()
  for (const message of input.batch) {
    if (!senders.has(message.from_handle)) {
      // This runtime's orchestration database names the sender, so its host is the card's own.
      senders.set(message.from_handle, {
        party: senderParty(message, input.db),
        hostId: LOCAL_EXECUTION_HOST_ID
      })
    }
  }
  return {
    kind: 'agent',
    message: 'mail-notice',
    senders: [...senders.values()],
    orchestration: {
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      runIds: [...new Set(input.batch.map((message) => message.run_id))],
      messageIds: input.batch.map((message) => message.id)
    }
  }
}

/** The pane the row recorded at send time is the sender's; the live lookup only fills gaps. */
function senderParty(
  message: PointerBatchMessage,
  db: OrchestrationDb | null
): OrchestrationPartyIdentity {
  const address = message.from_handle
  let party: OrchestrationPartyIdentity
  try {
    party = resolveOrchestrationParty(address, db)
  } catch {
    // A worker this host lost the identity of: what the address itself says.
    party = {
      address,
      terminalHandle: null,
      paneKey: null,
      orcaSessionId: parseOrcaSessionAddress(address)
    }
  }
  return { ...party, paneKey: message.sender_pane_key ?? party.paneKey }
}

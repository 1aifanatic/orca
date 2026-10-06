/**
 * Who the mail a chat is pointed at is from: every distinct sender, named the
 * way orchestration names a party, and each message's own sender and records. The run, dispatch
 * and message ids join back to orchestration's own rows while those exist.
 */

import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import {
  agentMessageSenderName,
  type AgentMessageSource,
  type AgentMessageSender
} from '../../../shared/agent-session-message-source'
import type { MessageRow, OrchestrationDb } from './db'
import { resolveOrchestrationParty } from './orchestration-party'

export type MailSourceMessage = Pick<MessageRow, 'id' | 'from_handle' | 'run_id'>

/** A name Orca controls for a party (never an agent-set title); null when it has none. */
export type SenderNameResolver = (party: AgentMessageSender['party']) => string | null

export function structuredMailSource(input: {
  db: OrchestrationDb | null
  mailboxHandle: string
  dispatchId: string | null
  batch: readonly MailSourceMessage[]
  senderName: SenderNameResolver
}): AgentMessageSource {
  const senders = new Map<string, AgentMessageSender>()
  for (const { from_handle: address } of input.batch) {
    if (!senders.has(address)) {
      const party = senderParty(address, input.db)
      senders.set(address, { party, name: snapshotName(input.senderName, party) })
    }
  }
  return {
    kind: 'agent',
    senders: [...senders.values()],
    orchestration: {
      message: 'mail-notice',
      mailbox: input.mailboxHandle,
      dispatchId: input.dispatchId,
      messages: input.batch.map((message) => ({
        messageId: message.id,
        runId: message.run_id,
        from: message.from_handle
      }))
    }
  }
}

function senderParty(address: string, db: OrchestrationDb | null): AgentMessageSender['party'] {
  try {
    const { paneKey: _credential, ...party } = resolveOrchestrationParty(address, db)
    return party
  } catch {
    // A worker this host lost the identity of: what the address itself says.
    return { address, terminalHandle: null, orcaSessionId: parseOrcaSessionAddress(address) }
  }
}

function snapshotName(
  senderName: SenderNameResolver,
  party: AgentMessageSender['party']
): string | null {
  try {
    return agentMessageSenderName(senderName(party))
  } catch {
    // A name is a label, never a reason the mail is not delivered.
    return null
  }
}

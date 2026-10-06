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

export type MailSourceMessage = Pick<
  MessageRow,
  'id' | 'from_handle' | 'run_id' | 'type' | 'payload'
>

/** A name from Orca's records for a party (never an agent-painted title); null when it has none.
 *  `reportedDispatchId`: the dispatch the sender's own `worker_done` among these messages names. */
export type SenderNameResolver = (
  party: AgentMessageSender['party'],
  reportedDispatchId?: string
) => string | null

/** The one way a sender is recorded on a message: its party as orchestration resolves the
 *  address, and a bounded snapshot of its name for when it is gone. */
export function agentMessageSender(
  address: string,
  db: OrchestrationDb | null,
  senderName: SenderNameResolver,
  reportedDispatchId?: string
): AgentMessageSender {
  const party = senderParty(address, db)
  return { party, name: snapshotName(senderName, party, reportedDispatchId) }
}

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
      senders.set(
        address,
        agentMessageSender(
          address,
          input.db,
          input.senderName,
          reportedDispatchId(input.batch, address)
        )
      )
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

/** The dispatch a sender's own `worker_done` here reports: the task it just finished, whose
 *  dispatch that report already settled. */
function reportedDispatchId(
  batch: readonly MailSourceMessage[],
  address: string
): string | undefined {
  for (const message of batch) {
    if (message.from_handle !== address || message.type !== 'worker_done' || !message.payload) {
      continue
    }
    try {
      const payload: unknown = JSON.parse(message.payload)
      const dispatchId =
        typeof payload === 'object' && payload !== null && 'dispatchId' in payload
          ? payload.dispatchId
          : undefined
      if (typeof dispatchId === 'string' && dispatchId.length > 0) {
        return dispatchId
      }
    } catch {
      // A payload that does not parse names no dispatch.
    }
  }
  return undefined
}

function snapshotName(
  senderName: SenderNameResolver,
  party: AgentMessageSender['party'],
  reportedDispatchId: string | undefined
): string | null {
  try {
    return agentMessageSenderName(senderName(party, reportedDispatchId))
  } catch {
    // A name is a label, never a reason the mail is not delivered.
    return null
  }
}

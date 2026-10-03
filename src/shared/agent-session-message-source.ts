// Who a chat message is from: the person at the composer, or Orca on behalf of other agents.
// Persisted with a queued card (`queued_messages.source_json`) and shaped for the sent message too,
// so the chat can name each sender and open it.

import { z } from 'zod'
import { isOrcaSessionId, type OrcaSessionId } from './orca-session-address'
import type { OrchestrationPartyIdentity } from './orchestration-party-identity'

/**
 * One agent a message speaks for, named by the orchestration database of the host that stores the
 * message: the only host whose agents can send today. A relayed sender adds its host here.
 */
export type AgentMessageSender = Readonly<{ party: OrchestrationPartyIdentity }>

/** The notice that orchestration mail is waiting, and the records it stands for while they exist. */
export type OrchestrationMailNotice = Readonly<{
  message: 'mail-notice'
  mailbox: string
  dispatchId: string | null
  runIds: readonly string[]
  messageIds: readonly string[]
}>

/** What Orca sends for other agents, one shape per message kind. */
export type OrchestrationAgentMessage = OrchestrationMailNotice

export type AgentMessageSource = Readonly<{
  kind: 'agent'
  /** Every distinct sender of what the message stands for, in mail order. */
  senders: readonly AgentMessageSender[]
  orchestration: OrchestrationAgentMessage
}>

export type AgentSessionMessageSource = Readonly<{ kind: 'user' }> | AgentMessageSource

export const USER_MESSAGE_SOURCE: AgentSessionMessageSource = { kind: 'user' }

/** Two of Orca's messages with one key are one message: a mail notice per mailbox, which counts the
 *  mail owed when it sends. Null for a person's. */
export function agentMessageKey(source: AgentSessionMessageSource): string | null {
  if (source.kind === 'user') {
    return null
  }
  switch (source.orchestration.message) {
    case 'mail-notice':
      return `mail-notice:${source.orchestration.mailbox}`
  }
}

const MESSAGE_SOURCE_VERSION = 1

const orcaSessionIdSchema = z.custom<OrcaSessionId>(
  (value) => typeof value === 'string' && isOrcaSessionId(value)
)

const mailNoticeSchema = z.object({
  message: z.literal('mail-notice'),
  mailbox: z.string(),
  dispatchId: z.string().nullable(),
  runIds: z.array(z.string()),
  messageIds: z.array(z.string())
})

// Not strict: a newer build may add a field, which this one keeps no use for and must not reject.
const storedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(MESSAGE_SOURCE_VERSION), kind: z.literal('user') }),
  z.object({
    v: z.literal(MESSAGE_SOURCE_VERSION),
    kind: z.literal('agent'),
    senders: z.array(
      z.object({
        party: z.object({
          address: z.string(),
          terminalHandle: z.string().nullable(),
          paneKey: z.string().nullable(),
          orcaSessionId: orcaSessionIdSchema.nullable()
        })
      })
    ),
    orchestration: z.discriminatedUnion('message', [mailNoticeSchema])
  })
])

export function serializeAgentSessionMessageSource(source: AgentSessionMessageSource): string {
  return JSON.stringify({ v: MESSAGE_SOURCE_VERSION, ...source })
}

/**
 * The stored value read back. Absent (a card from before the column) is the person's: only the
 * composer queued then. A value this build cannot read is the person's too, so it waits out every
 * pause as every card did before agents could queue: never sent unasked.
 */
export function readAgentSessionMessageSource(stored: unknown): AgentSessionMessageSource {
  const parsed = storedSourceSchema.safeParse(stored)
  if (!parsed.success) {
    return USER_MESSAGE_SOURCE
  }
  const { v: _version, ...source } = parsed.data
  return source
}

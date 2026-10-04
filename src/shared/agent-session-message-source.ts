// Who a chat message is from: the person at the composer, or another agent through Orca.
// Persisted with a queued card (`queued_messages.source_json`) and with the submission it becomes,
// so the chat can name each sender.

import { z } from 'zod'
import { isOrcaSessionId, type OrcaSessionId } from './orca-session-address'
import type { OrchestrationPartyIdentity } from './orchestration-party-identity'

/**
 * An agent a message is from, named by the orchestration database of the host that stores the
 * message: the only host whose agents can send today. A relayed sender adds its host here. No pane
 * key: it reads and consumes that agent's mailbox, so the host resolves it from the handle.
 */
export type AgentMessageSender = Readonly<{ party: Omit<OrchestrationPartyIdentity, 'paneKey'> }>

/** One orchestration message a turn carries: its record, and its sender's `senders` address. */
export type OrchestrationMailMessage = Readonly<{ messageId: string; runId: string; from: string }>

/** A mailbox's unread orchestration mail, delivered as the turn itself, in mail order. */
export type OrchestrationMail = Readonly<{
  message: 'mail'
  mailbox: string
  dispatchId: string | null
  messages: readonly OrchestrationMailMessage[]
}>

/** What a newer build wrote that this one cannot read: still an agent's, carrying nothing it knows. */
export type OrchestrationUnknownMessage = Readonly<{ message: 'unknown' }>

/** What Orca delivers for other agents, one shape per message kind. */
export type OrchestrationAgentMessage = OrchestrationMail | OrchestrationUnknownMessage

export type AgentMessageSource = Readonly<{
  kind: 'agent'
  /** Every distinct sender of the messages it carries, in mail order. */
  senders: readonly AgentMessageSender[]
  orchestration: OrchestrationAgentMessage
}>

export type AgentSessionMessageSource = Readonly<{ kind: 'user' }> | AgentMessageSource

export const USER_MESSAGE_SOURCE: AgentSessionMessageSource = { kind: 'user' }

const MESSAGE_SOURCE_VERSION = 1

const orcaSessionIdSchema = z.custom<OrcaSessionId>(
  (value) => typeof value === 'string' && isOrcaSessionId(value)
)

const mailSchema = z.object({
  message: z.literal('mail'),
  mailbox: z.string(),
  dispatchId: z.string().nullable(),
  messages: z.array(z.object({ messageId: z.string(), runId: z.string(), from: z.string() }))
})

// Not strict: a newer build may add a field, which this one keeps no use for and must not reject.
// Read in parts, so a sender or payload this build cannot read still leaves an agent's card.
const storedKindSchema = z.object({ kind: z.enum(['user', 'agent']) })
const storedSendersSchema = z.object({
  senders: z.array(
    z.object({
      party: z.object({
        address: z.string(),
        terminalHandle: z.string().nullable(),
        orcaSessionId: orcaSessionIdSchema.nullable()
      })
    })
  )
})
const storedMailSchema = z.object({
  v: z.literal(MESSAGE_SOURCE_VERSION),
  orchestration: mailSchema
})

/** The stored form, as a JSON value; `readAgentSessionMessageSource` reads it back. */
export function storedAgentSessionMessageSource(source: AgentSessionMessageSource): object {
  return { v: MESSAGE_SOURCE_VERSION, ...source }
}

export function serializeAgentSessionMessageSource(source: AgentSessionMessageSource): string {
  return JSON.stringify(storedAgentSessionMessageSource(source))
}

/**
 * The stored value read back. Absent (a card from before the column) is the person's: only the
 * composer queued then, and so is a value with no readable `kind`. An agent's value whose senders
 * or payload this build cannot read stays an agent's, carrying no mail it knows.
 */
export function readAgentSessionMessageSource(stored: unknown): AgentSessionMessageSource {
  if (storedKindSchema.safeParse(stored).data?.kind !== 'agent') {
    return USER_MESSAGE_SOURCE
  }
  const mail = storedMailSchema.safeParse(stored)
  return {
    kind: 'agent',
    senders: storedSendersSchema.safeParse(stored).data?.senders ?? [],
    orchestration: mail.success ? mail.data.orchestration : { message: 'unknown' }
  }
}

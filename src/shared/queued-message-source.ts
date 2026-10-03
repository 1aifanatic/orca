// Who queued a message in a chat's queue: the person at the composer, or Orca on behalf of other
// agents. Persisted with the card (`queued_messages.source_json`), so it is shaped for what later
// readers need: the restart pause reads `kind`, and the chat can name each sender and open it.

import { z } from 'zod'
import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import { isOrcaSessionId, type OrcaSessionId } from './orca-session-address'
import type { OrchestrationPartyIdentity } from './orchestration-party-identity'

/** One agent a queued message speaks for. */
export type QueuedMessageSender = Readonly<{
  party: OrchestrationPartyIdentity
  /** The execution host whose orchestration database names `party`, relative to the host that
   *  stores the card; a relayed sender is named by the address that host gave it. */
  hostId: ExecutionHostId
}>

export type QueuedMessageAgentSource = Readonly<{
  kind: 'agent'
  /** What Orca queued for the agents: today only the notice that orchestration mail is waiting. */
  message: 'mail-notice'
  /** Every distinct sender of the mail the notice stands for, in mail order. */
  senders: readonly QueuedMessageSender[]
  /** The orchestration records the message stands for, while they exist. */
  orchestration: Readonly<{
    mailbox: string
    dispatchId: string | null
    runIds: readonly string[]
    messageIds: readonly string[]
  }>
}>

export type QueuedMessageSource = Readonly<{ kind: 'user' }> | QueuedMessageAgentSource

export const USER_QUEUED_MESSAGE_SOURCE: QueuedMessageSource = { kind: 'user' }

const QUEUED_MESSAGE_SOURCE_VERSION = 1

const orcaSessionIdSchema = z.custom<OrcaSessionId>(
  (value) => typeof value === 'string' && isOrcaSessionId(value)
)
const executionHostIdSchema = z.custom<ExecutionHostId>(
  (value) => typeof value === 'string' && normalizeExecutionHostId(value) === value
)

// Not strict: a newer build may add a field, which this one keeps no use for and must not reject.
const storedSourceSchema = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(QUEUED_MESSAGE_SOURCE_VERSION), kind: z.literal('user') }),
  z.object({
    v: z.literal(QUEUED_MESSAGE_SOURCE_VERSION),
    kind: z.literal('agent'),
    message: z.literal('mail-notice'),
    senders: z.array(
      z.object({
        party: z.object({
          address: z.string(),
          terminalHandle: z.string().nullable(),
          paneKey: z.string().nullable(),
          orcaSessionId: orcaSessionIdSchema.nullable()
        }),
        hostId: executionHostIdSchema
      })
    ),
    orchestration: z.object({
      mailbox: z.string(),
      dispatchId: z.string().nullable(),
      runIds: z.array(z.string()),
      messageIds: z.array(z.string())
    })
  })
])

export function serializeQueuedMessageSource(source: QueuedMessageSource): string {
  return JSON.stringify({ v: QUEUED_MESSAGE_SOURCE_VERSION, ...source })
}

/**
 * The stored value read back. Absent (a card from before the column) is the person's: only the
 * composer queued then. A value this build cannot read is the person's too, so it holds after a
 * restart as every card did before agents could queue: never sent unasked.
 */
export function readQueuedMessageSource(stored: unknown): QueuedMessageSource {
  const parsed = storedSourceSchema.safeParse(stored)
  if (!parsed.success) {
    return USER_QUEUED_MESSAGE_SOURCE
  }
  const { v: _version, ...source } = parsed.data
  return source
}

// What the chat's host lets this client do with the message queue: whether a send may ask to be
// queued, and whether a /compact or /clear may wait in line as a card.

import { useMemo } from 'react'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  useStructuredAgentSessionHostQueuesClear,
  useStructuredAgentSessionHostQueuesCommands,
  useStructuredAgentSessionHostQueuesMessagesState
} from '@/runtime/structured-agent-session-host-capability'
import { commandCardWaiting } from './structured-agent-session-queued-cards'
import type { StructuredAgentSessionQueueDelivery } from '../../../../shared/structured-agent-session-outbox-delivery'

export function useStructuredAgentSessionQueueGates(args: {
  target: RuntimeClientTarget
  queuedMessages: readonly AgentSessionQueuedMessage[] | null | undefined
  /** The chat-wide "queue follow-ups" setting. */
  queueFollowUps: boolean
  /** Every pending prompt is one this build cannot answer. */
  promptsUnanswerableHere: boolean
}): {
  queueCapable: boolean
  queueDelivery: StructuredAgentSessionQueueDelivery
  commandsWait: boolean
  clearWaits: boolean
} {
  const { promptsUnanswerableHere, queueFollowUps, queuedMessages, target } = args
  // Only a capable host may see `delivery` or the queuedMessage RPCs; against
  // anything older this client must look exactly like today's.
  const queueCapability = useStructuredAgentSessionHostQueuesMessagesState(target)
  const queueCapable = queueCapability === 'supported'
  // A /compact or /clear waits in line only where its card renders.
  const commandsWait = useStructuredAgentSessionHostQueuesCommands(target) && queueCapable
  const clearWaits = useStructuredAgentSessionHostQueuesClear(target) && queueCapable
  // A send after a command the queue will run goes behind it, even with follow-ups off.
  // A host's queue waits on any pending prompt, and nothing here can settle one this build cannot
  // answer: the send must start a turn, after which the card's cancel works.
  const queueEnabled =
    (queueFollowUps || commandCardWaiting(queuedMessages)) && !promptsUnanswerableHere
  const queueDelivery = useMemo(
    () => ({ capability: queueCapability, enabled: queueEnabled }),
    [queueCapability, queueEnabled]
  )
  return { queueCapable, queueDelivery, commandsWait, clearWaits }
}

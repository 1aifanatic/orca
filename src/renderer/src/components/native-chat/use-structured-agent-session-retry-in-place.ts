// A Retry of a message no agent ever took. A host that can queues that same message again, under its
// own id, so the chat never holds two copies and a second press from anywhere sends nothing more.
// An older host cannot: this desktop's own message is sent again as a new one, from its outbox, and
// one sent elsewhere has no Retry here.

import { useCallback } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isRequeueableAgentJournalSubmission } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

export function useStructuredAgentSessionRetryInPlace(args: {
  target: RuntimeClientTarget
  mutate: StructuredAgentSessionMutate
  submissions: readonly AgentJournalSubmission[]
  /** The outbox's Retry, which sends this desktop's own message again as a new one. */
  outboxRetry: (clientMessageId: string) => void
}): {
  retry: (clientMessageId: string) => void
  /** Undefined where the host cannot queue a message again. */
  retryInPlace: ((clientMessageId: string) => void) | undefined
} {
  const { mutate, outboxRetry, submissions } = args
  const capable =
    useStructuredAgentSessionHostCapabilityState(
      args.target,
      AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY
    ) === 'supported'
  const retryInPlace = useCallback(
    (clientMessageId: string) => {
      // The stream's `pending` moves the message back to sending; nothing is set here, or a snapshot
      // still showing it rejected would flip it straight back.
      void mutate('agentSession.retryMessage', 'agentSession.retryMessage', { clientMessageId })
    },
    [mutate]
  )
  const retry = (clientMessageId: string): void => {
    const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
    if (capable && submission && isRequeueableAgentJournalSubmission(submission)) {
      retryInPlace(clientMessageId)
    } else {
      outboxRetry(clientMessageId)
    }
  }
  return { retry, retryInPlace: capable ? retryInPlace : undefined }
}

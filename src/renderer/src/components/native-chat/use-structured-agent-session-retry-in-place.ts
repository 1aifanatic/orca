// A Retry of a message no agent ever took. A host that can queues that same message again, under its
// own id, so the chat never holds two copies and a second press from anywhere sends nothing more.
// A host known not to: this desktop's own message is sent again as a new one, from its outbox, and
// one sent elsewhere has no Retry here. Until the host has said which, a press waits for the answer:
// a new copy sent then would leave the original with a live Retry once the host says it can.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import { AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { isRequeueableAgentJournalSubmission } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

const NO_HELD_PRESSES: ReadonlySet<string> = new Set()

export function useStructuredAgentSessionRetryInPlace(args: {
  target: RuntimeClientTarget
  mutate: StructuredAgentSessionMutate
  submissions: readonly AgentJournalSubmission[]
  /** The outbox's Retry, which sends this desktop's own message again as a new one. */
  outboxRetry: (clientMessageId: string) => void
}): {
  retry: (clientMessageId: string) => void
  /** Undefined where the host is not known to queue a message again. */
  retryInPlace: ((clientMessageId: string) => void) | undefined
  /** Presses waiting for the host's answer: their Retry shows as pending, and takes no press. */
  retryHeld: ReadonlySet<string>
} {
  const { mutate, outboxRetry, submissions } = args
  const capability = useStructuredAgentSessionHostCapabilityState(
    args.target,
    AGENT_SESSION_RETRY_MESSAGE_RUNTIME_CAPABILITY
  )
  const retryInPlace = useCallback(
    (clientMessageId: string) => {
      // The stream's `pending` moves the message back to sending; nothing is set here, or a snapshot
      // still showing it rejected would flip it straight back.
      void mutate('agentSession.retryMessage', 'agentSession.retryMessage', { clientMessageId })
    },
    [mutate]
  )
  // Presses made while the host has not answered, carried out once it has. The ref is what the answer
  // reads; the state is what the chat draws.
  const held = useRef(new Set<string>())
  const [retryHeld, setRetryHeld] = useState<ReadonlySet<string>>(NO_HELD_PRESSES)
  const route = (clientMessageId: string): void => {
    const submission = submissions.find((entry) => entry.clientMessageId === clientMessageId)
    if (!submission || !isRequeueableAgentJournalSubmission(submission)) {
      outboxRetry(clientMessageId)
    } else if (capability === 'supported') {
      retryInPlace(clientMessageId)
    } else if (capability === 'unsupported') {
      outboxRetry(clientMessageId)
    } else if (!held.current.has(clientMessageId)) {
      held.current.add(clientMessageId)
      setRetryHeld(new Set(held.current))
    }
  }
  const routeRef = useRef(route)
  // Declared first, so the answer below routes with this render's view of the messages.
  useEffect(() => {
    routeRef.current = route
  })
  useEffect(() => {
    if (capability === 'unknown' || held.current.size === 0) {
      return
    }
    const presses = [...held.current]
    held.current.clear()
    setRetryHeld(NO_HELD_PRESSES)
    for (const clientMessageId of presses) {
      routeRef.current(clientMessageId)
    }
  }, [capability])
  return {
    retry: route,
    retryInPlace: capability === 'supported' ? retryInPlace : undefined,
    retryHeld
  }
}

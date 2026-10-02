// The user's Retry on a stuck outbox entry: requeue it, rotating the operation
// id when the host has forgotten the recorded one.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  structuredAgentSessionEntryIdExpired,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import {
  commitStructuredAgentSessionOutbox,
  getStructuredAgentSessionOutbox
} from './structured-agent-session-outbox-storage'

export function retryStructuredAgentSessionOutboxEntry(args: {
  clientMessageId: string
  sessionId: string
  submissions: readonly AgentJournalSubmission[]
  setError: (error: string | null) => void
  createOperationId: () => string
}): void {
  const { clientMessageId, sessionId, setError, submissions } = args
  const submission = submissions.find((candidate) => candidate.clientMessageId === clientMessageId)
  const outbox = getStructuredAgentSessionOutbox(sessionId)
  const current = outbox.find((entry) => entry.clientMessageId === clientMessageId)
  // An expired id is refused for good, so only a new one sends it; its row told the user to check
  // the chat first. A refusal that settled the message already rotated it, and one the host
  // rejected after recording it has no Retry.
  if (current && structuredAgentSessionEntryIdExpired(current)) {
    const rotated = outbox.map((entry) =>
      entry.clientMessageId === clientMessageId
        ? {
            ...retriedByUser(entry),
            clientMessageId: args.createOperationId(),
            state: 'queued' as const,
            lastAttemptAt: null,
            retryAfterUnknownSubmittedAt: null
          }
        : entry
    )
    if (!commitStructuredAgentSessionOutbox(sessionId, rotated, { onlyIfSaved: true })) {
      setError('Message could not be saved to the outbox')
    }
    return
  }
  const retryAfterUnknownSubmittedAt =
    submission?.dispatchState === 'unknown'
      ? submission.submittedAt
      : current?.state === 'unconfirmed'
        ? -1
        : null
  const next = outbox.map((entry) =>
    entry.clientMessageId === clientMessageId
      ? {
          ...retriedByUser(entry),
          state: 'queued' as const,
          retryAfterUnknownSubmittedAt
        }
      : entry
  )
  if (!commitStructuredAgentSessionOutbox(sessionId, next, { onlyIfSaved: true })) {
    setError('Message could not be saved to the outbox')
  }
}

/** The user's own Retry is what a Stop, or a failure saved on the message, left it waiting for. */
function retriedByUser({
  outlivedStop: _retried,
  lastFailure: _sentAgain,
  ...entry
}: StructuredAgentSessionOutboxEntry): StructuredAgentSessionOutboxEntry {
  return entry
}

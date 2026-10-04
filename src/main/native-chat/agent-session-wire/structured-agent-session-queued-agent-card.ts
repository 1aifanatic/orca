// An agent's card stands for something its sender owns (orchestration mail), so the sender judges
// it again at the moment it would send, in the drain's own serialized step: send it as written,
// restate it, or withdraw it unsent. The judge is injected by the host's owner, so native chat
// never imports orchestration.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { QueuedMessageRestatement } from '../agent-session-journal/queued-message-restatement'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export type QueuedAgentCardVerdict =
  | { kind: 'send' }
  /** Still owed, but not as written: what it says now. */
  | { kind: 'restate'; body: AgentJournalMessageItem; source: AgentMessageSource }
  /** Owed nothing any more. */
  | { kind: 'withdraw' }
  /** The judge cannot read what it judges by right now: it decides nothing, and the card waits. */
  | { kind: 'defer' }

export type QueuedAgentCardJudge = (input: {
  sessionId: string
  source: AgentMessageSource
}) => QueuedAgentCardVerdict

export const SEND_AS_WRITTEN: QueuedAgentCardVerdict = { kind: 'send' }

/** A person's card sends as written. A judge that fails answers the same: bookkeeping never holds
 *  the queue. */
function judgeQueuedCard(
  judge: QueuedAgentCardJudge,
  input: {
    sessionId: string
    row: Pick<QueuedMessageRow, 'messageId' | 'source'>
    logger: StructuredAgentSessionLogger
  }
): QueuedAgentCardVerdict {
  const { source, messageId } = input.row
  if (source.kind === 'user') {
    return SEND_AS_WRITTEN
  }
  try {
    return judge({ sessionId: input.sessionId, source })
  } catch (error) {
    input.logger.warn("judging an agent's queued card failed; sending it as written", {
      scope: 'queued-agent-card',
      sessionId: input.sessionId,
      messageId,
      error
    })
    return SEND_AS_WRITTEN
  }
}

/** The consume's restatement for a `restate` verdict, fingerprinted for the session sending it
 *  exactly as `queuedMessageFingerprint` does. */
function queuedCardRestatement(
  sessionId: string,
  verdict: QueuedAgentCardVerdict
): QueuedMessageRestatement | undefined {
  if (verdict.kind !== 'restate') {
    return undefined
  }
  const fingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body: verdict.body }
  })
  return { body: verdict.body, fingerprint, source: verdict.source }
}

/** What the drain does with the card it picked: send this, withdraw it, or leave it waiting. */
export function drainableQueuedCard(input: {
  sessionId: string
  row: QueuedMessageRow
  judge: QueuedAgentCardJudge
  logger: StructuredAgentSessionLogger
}):
  | { kind: 'withdraw' }
  | { kind: 'defer' }
  | {
      kind: 'send'
      body: AgentJournalMessageItem
      fingerprint: string
      restated?: QueuedMessageRestatement
    } {
  const verdict = judgeQueuedCard(input.judge, input)
  if (verdict.kind === 'withdraw' || verdict.kind === 'defer') {
    return verdict
  }
  const restated = queuedCardRestatement(input.sessionId, verdict)
  return restated
    ? { kind: 'send', body: restated.body, fingerprint: restated.fingerprint, restated }
    : { kind: 'send', body: input.row.body, fingerprint: input.row.fingerprint }
}

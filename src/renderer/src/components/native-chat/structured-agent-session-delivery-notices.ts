// What each of the structured chat's own messages says under it about its delivery. Derived from
// the sender's in-memory sends and the host's rows on every render, never stored.

import {
  readAgentSessionFailureFact,
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../../shared/agent-session-failure'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import { isStructuredAgentSessionStartFailureRow } from '../../../../shared/structured-agent-session-start-failure-row-key'
import { structuredAgentSessionRejectionParts } from '../../../../shared/structured-agent-session-rejection-words'
import { structuredAgentSessionRejectedShownInPlace } from '../../../../shared/structured-agent-session-message-projection'
import { translate } from '@/i18n/i18n'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import type { NativeChatDeliveryNotice } from './NativeChatMessageRow'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

/** One shared value, so a rebuilt map re-renders no row still sending. */
const STRUCTURED_AGENT_SESSION_DELIVERY_SENDING: NativeChatDeliveryNotice = { sending: true }
const NO_COMMANDS: ReadonlySet<string> = new Set()

/** The facts the chat's loaded start-failure rows state. */
export function structuredAgentSessionStartFailureFacts(
  items: readonly AgentJournalRenderItem[]
): AgentSessionFailureFact[] {
  const facts: AgentSessionFailureFact[] = []
  for (const item of items) {
    if (item.body.kind === 'status' && isStructuredAgentSessionStartFailureRow(item.itemId)) {
      const fact = readAgentSessionFailureFact(item.body.failure)
      if (fact) {
        facts.push(fact)
      }
    }
  }
  return facts
}

/** Whether two facts are one failure: a start's row and the messages it rejected share one. */
export function sameAgentSessionFailureFact(
  a: AgentSessionFailureFact,
  b: AgentSessionFailureFact
): boolean {
  return (
    a.kind === b.kind &&
    a.detail?.text === b.detail?.text &&
    a.detail?.audience === b.detail?.audience &&
    a.refusal?.code === b.refusal?.code &&
    a.refusal?.details?.reason === b.refusal?.details?.reason &&
    a.attachment?.reason === b.attachment?.reason &&
    a.attachment?.limit === b.attachment?.limit &&
    a.retry?.error === b.retry?.error &&
    a.retry?.status === b.retry?.status
  )
}

/** Whether a loaded start-failure row already states this failure. Matching is identity, not
 *  wording: what this build can read is enough. */
export function agentSessionFailureStatedByStartRow(
  failure: unknown,
  startFailures: readonly AgentSessionFailureFact[]
): boolean {
  const fact = readAgentSessionFailureFact(failure)
  return (
    fact !== undefined && startFailures.some((stated) => sameAgentSessionFailureFact(stated, fact))
  )
}

function hostRejectionNoticeText(
  submission: AgentJournalSubmission,
  agentName: string,
  startFailures: readonly AgentSessionFailureFact[]
): string {
  if (agentSessionFailureStatedByStartRow(submission.rejection, startFailures)) {
    return agentSessionWriteNoticeText(agentSessionWriteNotDoneParts('send'))
  }
  return agentSessionWriteNoticeText(
    structuredAgentSessionRejectionParts(
      submission.reason,
      'send',
      readWholeAgentSessionFailureFact(submission.rejection),
      { agentName }
    )
  )
}

/** The line under a message that may not have reached its agent. */
export function structuredAgentSessionInDoubtText(agentName: string): string {
  return translate(
    'components.native-chat.deliveryInDoubt',
    "Orca couldn't confirm this message reached {{value0}}.",
    { value0: agentName }
  )
}

/** The host's in-doubt rows a person may still need to send again: one sent again since, under a
 *  new id with the same content, says nothing any more. */
function inDoubtSubmissions(
  submissions: readonly AgentJournalSubmission[],
  commandItemIds: ReadonlySet<string>
): AgentJournalSubmission[] {
  return submissions.filter(
    (submission, index) =>
      submission.dispatchState === 'unknown' &&
      !commandItemIds.has(agentJournalSubmissionKey(submission.clientMessageId)) &&
      !submissions
        .slice(index + 1)
        .some((later) => later.payloadFingerprint === submission.payloadFingerprint)
  )
}

/**
 * Keyed by the message id the transcript renders each message under; `agentName` is the chat's
 * agent, for the words. A message on its way says so quietly; one whose delivery nobody can confirm
 * (the host's `unknown` row, or a send of this window nothing answered in time) says so on its own
 * row with Send again, and holds nothing up; one the host rejected is worded from the host's fact.
 */
export function structuredAgentSessionDeliveryNotices(args: {
  pending: readonly StructuredAgentSessionPendingSend[]
  submissions: readonly AgentJournalSubmission[]
  /** The loaded rows: an in-doubt message is sent again from its own row's body. */
  journalItems: readonly AgentJournalRenderItem[]
  agentName: string
  sendAgain: (clientMessageId: string, body: AgentJournalMessageItem) => void
  /** What the loaded start-failure rows state, from `structuredAgentSessionStartFailureFacts`. */
  startFailures: readonly AgentSessionFailureFact[]
  /** The queue's live cards, which the transcript leaves a rejected message to. */
  queuedMessageIds?: readonly string[]
  /** The loaded commands, from `structuredAgentSessionCommandItemIds`: they report their own. */
  commandItemIds?: ReadonlySet<string>
}): ReadonlyMap<string, NativeChatDeliveryNotice> {
  const { agentName, sendAgain, submissions } = args
  const commandItemIds = args.commandItemIds ?? NO_COMMANDS
  const notices = new Map<string, NativeChatDeliveryNotice>()
  const inDoubt = structuredAgentSessionInDoubtText(agentName)
  for (const entry of args.pending) {
    const id = agentJournalSubmissionKey(entry.clientMessageId)
    if (entry.phase === 'waiting' || entry.phase === 'sending') {
      notices.set(id, STRUCTURED_AGENT_SESSION_DELIVERY_SENDING)
    } else if (entry.phase === 'in-doubt') {
      notices.set(id, {
        text: inDoubt,
        onSendAgain: () => sendAgain(entry.clientMessageId, entry.body)
      })
    }
  }
  const bodies = new Map<string, AgentJournalMessageItem>()
  for (const item of args.journalItems) {
    if (item.body.kind === 'message' && item.body.role === 'user') {
      bodies.set(item.itemId, item.body)
    }
  }
  for (const submission of inDoubtSubmissions(submissions, commandItemIds)) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    const body = bodies.get(id)
    if (body) {
      notices.set(id, {
        text: inDoubt,
        onSendAgain: () => sendAgain(submission.clientMessageId, body)
      })
    }
  }
  const shown = structuredAgentSessionRejectedShownInPlace(
    submissions,
    args.queuedMessageIds ?? [],
    commandItemIds
  )
  for (const submission of submissions) {
    const id = agentJournalSubmissionKey(submission.clientMessageId)
    if (submission.dispatchState === 'rejected' && shown.has(id)) {
      notices.set(id, {
        text: hostRejectionNoticeText(submission, agentName, args.startFailures)
      })
    }
  }
  return notices
}

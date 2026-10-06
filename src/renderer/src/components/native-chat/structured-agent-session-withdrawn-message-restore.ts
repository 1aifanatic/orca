import { useMemo } from 'react'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { getStructuredAgentSessionOutbox } from './structured-agent-session-outbox-storage'
import { appendNativeChatAttachmentCache } from './use-native-chat-composer-attachments'
import type { StructuredAgentSessionSendDisposition } from '../../../../shared/structured-agent-session-send-disposition'
import type { AgentSessionWriteRefusal } from '../../../../shared/agent-session-write-failure'
import { agentSessionWriteNoticeParts } from '../../../../shared/agent-session-refusal-notice'

/** The host refused the message for an attachment it no longer stores: sending the same message
 *  again can never succeed, so only the sender can fix it. */
function attachmentExpiredRefusal(
  entry: StructuredAgentSessionOutboxEntry
): AgentSessionWriteRefusal | null {
  const failure = entry.lastFailure
  return failure?.kind === 'refused' &&
    failure.code === 'agent_session_operation_invalid' &&
    failure.details?.reason === 'attachmentExpired'
    ? failure
    : null
}

/** Puts each message's text and images into the composer, after whatever is there. */
/** Puts a message's text and images into a composer, after whatever is there. */
export function returnMessageToComposer(
  composerScopeKey: string,
  /** Unique to this message, so its images never collide with ones already attached. */
  attachmentIdPrefix: string,
  blocks: AgentJournalMessageItem['blocks']
): void {
  appendNativeChatDraftCache(
    composerScopeKey,
    blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  )
  appendNativeChatAttachmentCache(
    composerScopeKey,
    blocks.flatMap((block, index) =>
      block.type === 'image-ref' && block.path
        ? [{ id: `${attachmentIdPrefix}-${index}`, path: block.path }]
        : []
    )
  )
}

/**
 * Gives the sender back what a Stop withdrew: its text and images go into this pane's composer,
 * after whatever is there. Called before the entries leave storage, so a failure between the two
 * repeats the text rather than losing it. Only this client's outbox holds them, so no other viewer
 * gets them.
 */
function restoreWithdrawnMessages(
  sessionId: string,
  composerScopeKey: string | undefined,
  withdrawn: readonly StructuredAgentSessionOutboxEntry[]
): void {
  if (!composerScopeKey || withdrawn.length === 0) {
    return
  }
  // What the outbox no longer holds was already given back by whichever view dropped it first.
  const held = new Set(
    getStructuredAgentSessionOutbox(sessionId).map((entry) => entry.clientMessageId)
  )
  for (const entry of withdrawn) {
    if (!held.has(entry.clientMessageId)) {
      continue
    }
    returnMessageToComposer(
      composerScopeKey,
      `withdrawn-${entry.clientMessageId}`,
      entry.body.blocks
    )
  }
}

export function useStructuredAgentSessionWithdrawnRestore(
  sessionId: string,
  /** Absent where no composer shows this session; the entries are then only dropped. */
  composerScopeKey: string | undefined
): {
  /** The entries the host settled as withdrawn by a Stop. */
  byHost: (
    entries: readonly StructuredAgentSessionOutboxEntry[],
    submissions: readonly AgentJournalSubmission[]
  ) => void
  /** Entries a Stop took out of the outbox here, before the host held them. */
  byStop: (entries: readonly StructuredAgentSessionOutboxEntry[]) => void
  /** A send's outcome, with any message refused for an expired attachment taken back out and
   *  returned to the composer, where the attachment can be removed, instead of held for a Retry
   *  that cannot succeed. Kept for Retry where no composer shows this session. */
  byRefusal: (
    disposition: StructuredAgentSessionSendDisposition
  ) => StructuredAgentSessionSendDisposition
} {
  return useMemo(
    () => ({
      byHost: (entries, submissions) => {
        // A hand-off of a queued draft is never restored: the Stop that withdrew it put the draft
        // back as a card, which carries the text.
        const withdrawn = new Set(
          submissions
            .filter(
              (submission) =>
                dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined
            )
            .map((submission) => submission.clientMessageId)
        )
        restoreWithdrawnMessages(
          sessionId,
          composerScopeKey,
          entries.filter((entry) => withdrawn.has(entry.clientMessageId))
        )
      },
      byStop: (entries) => restoreWithdrawnMessages(sessionId, composerScopeKey, entries),
      byRefusal: (disposition) => {
        const returned = disposition.entries.filter(
          (entry) => attachmentExpiredRefusal(entry) !== null
        )
        const refusal = returned[0] && attachmentExpiredRefusal(returned[0])
        if (!composerScopeKey || !refusal) {
          return disposition
        }
        // Only the send's own view applies its outcome, so nothing else gives these back.
        for (const entry of returned) {
          returnMessageToComposer(
            composerScopeKey,
            `withdrawn-${entry.clientMessageId}`,
            entry.body.blocks
          )
        }
        return {
          entries: disposition.entries.filter((entry) => !returned.includes(entry)),
          error: agentSessionWriteNoticeParts(refusal, 'send')
        }
      }
    }),
    [composerScopeKey, sessionId]
  )
}

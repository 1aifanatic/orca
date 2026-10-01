import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-outbox'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type {
  NativeChatDraftSentBaseline,
  PersistedNativeChatDraft
} from './native-chat-draft-storage'
import {
  nativeChatPendingContentKey,
  nativeChatUserMessageContentKey
} from './native-chat-pending-occurrence'

/** What a structured chat's view has seen of its host's history. */
export type NativeChatSentHistory = {
  /** The newest row seen; saved with the draft. */
  latest: NativeChatDraftSentBaseline
  /** Messages the host accepted, as loaded. */
  sent: readonly { sequence: number; body: AgentJournalMessageItem }[]
}

/** Whether the host accepted a message with the draft's exact content after the draft was saved. */
export function draftWasSentAfterSaving(
  draft: Pick<PersistedNativeChatDraft, 'text' | 'attachments' | 'sentBaseline'>,
  history: NativeChatSentHistory
): boolean {
  const baseline = draft.sentBaseline
  // Another epoch's rows cannot be ordered against the baseline; keep the draft.
  if (!baseline || baseline.epoch !== history.latest.epoch) {
    return false
  }
  // Built the way a send builds it, so trimming and image order match what the host received.
  const draftBody = structuredAgentSessionSendBody(
    draft.text,
    draft.attachments.map(({ path }) => ({ path, previewUri: path }))
  )
  return history.sent.some(
    ({ sequence, body }) => sequence > baseline.sequence && sameSentMessage(body, draftBody)
  )
}

// Text and every image must match: a draft with an image the send did not carry was not sent.
function sameSentMessage(left: AgentJournalMessageItem, right: AgentJournalMessageItem): boolean {
  const content = (body: AgentJournalMessageItem): string =>
    JSON.stringify(
      body.blocks.flatMap((block) =>
        block.type === 'text'
          ? [['text', block.text.trimEnd()]]
          : block.type === 'image-ref'
            ? [['image', block.path]]
            : []
      )
    )
  return left.role === 'user' && content(left) === content(right)
}

/**
 * Whether a chat over a terminal agent's transcript shows the draft typed as a user turn after
 * the last one seen when it was saved. The content key is the one a sent message's own bubble is
 * matched to its transcript turn by.
 */
export function draftWasTypedAfterSaving(
  draft: Pick<PersistedNativeChatDraft, 'text' | 'attachments' | 'transcriptBaseline'>,
  messages: readonly NativeChatMessage[]
): boolean {
  const baseline = draft.transcriptBaseline
  if (!baseline) {
    return false
  }
  const userTurns = messages.filter((message) => message.role === 'user')
  const after =
    baseline.lastUserTurnId === null
      ? 0
      : userTurns.findIndex((turn) => turn.id === baseline.lastUserTurnId) + 1
  // The turn it was saved after is gone (another session after /clear, or an older page): the
  // order cannot be told, so the draft is kept.
  if (after === 0 && baseline.lastUserTurnId !== null) {
    return false
  }
  const draftKey = nativeChatPendingContentKey({
    text: draft.text,
    imagePaths: draft.attachments.map(({ path }) => path)
  })
  return userTurns.slice(after).some((turn) => nativeChatUserMessageContentKey(turn) === draftKey)
}

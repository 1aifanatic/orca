// The sentence a person reads beside each failure fact, and the one constructor that writes both.
//
// A row's `text`, a rejected message's `reason` and a conversation command's `error` are what
// every released client prints as they are, so the host writes them here, from the fact, and
// nowhere else: never Orca's own error text, a refusal's message, or a probe's evidence. A
// provider's words reach the sentence only when the provider wrote them for a person. The table
// is also the English default for a client that chooses its own copy from the fact.

import type {
  AgentSessionAttachmentProblem,
  AgentSessionAttachmentProblemReason,
  AgentSessionFailureFact,
  AgentSessionFailureKind,
  ProviderDiagnostic
} from './agent-session-failure'
import type { AgentSessionWireRefusalCode } from './agent-session-wire-refusals'
import {
  DISPATCH_REJECTED_CANCELLED,
  DISPATCH_REJECTED_CODEX_QUEUE_FULL,
  DISPATCH_REJECTED_QUEUE_FULL,
  DISPATCH_REJECTED_WRITE_FAILED
} from './structured-agent-session-dispatch-rejection'

declare const failureSentence: unique symbol

/** Words only `agentSessionFailureWords` makes, so no writer can put its own beside a fact. */
export type AgentSessionFailureSentence = string & { readonly [failureSentence]: true }

/** A status row that reports a failure. */
export type AgentSessionFailureRowWords = {
  text: AgentSessionFailureSentence
  failure: AgentSessionFailureFact
}

/** A rejection as the host writes it: the sentence (or, for the cases released clients already
 *  hide, the legacy marker) they print, and the fact newer ones read. */
export type AgentJournalDispatchRejection = {
  reason: AgentSessionFailureSentence
  rejection: AgentSessionFailureFact
}

/** `row`: a status row, about the chat. `rejection`: a rejected message's reason, about it. */
export type AgentSessionFailureSurface = 'row' | 'rejection'

export type AgentSessionFailureWordsContext = {
  /** The chat's agent, when the writer knows it. */
  agentName?: string
  /** Names the legacy queue-full marker; without it a full queue is worded as a sentence. */
  provider?: 'claude' | 'codex'
}

/**
 * Whether a refused start leaves the chat anything to start again from. `false`: this host has
 * nothing to restart it from — no record, or none it can run — so only a new chat continues.
 * A new wire code does not compile until it is classified here.
 */
export const START_REFUSAL_RESUMABLE: Record<AgentSessionWireRefusalCode, boolean> = {
  execution_owner_reconciling: true,
  agent_session_conflict: true,
  agent_session_checkpoint_stale: true,
  agent_session_ownership_unknown: true,
  agent_session_operation_capacity: true,
  structured_agent_session_unsupported: false,
  agent_session_operation_conflict: true,
  agent_session_operation_expired: true,
  agent_session_operation_invalid: true,
  agent_session_operation_unknown: true,
  agent_session_item_revision_stale: true,
  agent_session_already_resolved: true,
  agent_session_identity_required: false,
  agent_session_journal_unreadable: true,
  agent_session_owner_restart_failed: true
}

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512
const BYTES_PER_MB = 1024 * 1024

type Sentence = (
  context: AgentSessionFailureWordsContext,
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface
) => string

function quotingPersonDetail(lead: string, detail: ProviderDiagnostic | undefined): string {
  const quoted =
    detail?.audience === 'person'
      ? detail.text
          .slice(0, MAX_QUOTED_DETAIL_CHARS)
          .trim()
          .replace(/[.\s]+$/, '')
      : ''
  return quoted ? `${lead}: ${quoted}.` : `${lead}.`
}

function couldNot(verb: string): Sentence {
  return ({ agentName }, fact) => {
    const failed = `${agentName ?? 'The agent'} couldn't ${verb}.`
    // Only a terminal agent an older build recorded holds a claim; quitting it frees the chat.
    if (fact.refusal?.details?.reason === 'claimConflicted') {
      return `${failed} This chat is still open in a terminal agent. Quit that agent to continue the chat here.`
    }
    const code = fact.refusal?.code
    return code && !START_REFUSAL_RESUMABLE[code]
      ? `${failed} Start a new chat to continue.`
      : failed
  }
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / BYTES_PER_MB) * 10) / 10} MB`
}

const NOT_SENT = 'so the message was not sent.'

const ATTACHMENT_SENTENCES = {
  empty: () => `An image on this message is empty, ${NOT_SENT}`,
  tooLarge: (_, { limit }) =>
    limit
      ? `An image on this message is larger than ${megabytes(limit)}, ${NOT_SENT}`
      : `An image on this message is too large, ${NOT_SENT}`,
  tooMany: ({ agentName }, { limit }) =>
    limit
      ? `${agentName ?? 'The agent'} accepts at most ${limit} images in one message, so this message was not sent.`
      : 'This message has too many images, so it was not sent.',
  totalTooLarge: (_, { limit }) =>
    limit
      ? `The images on this message add up to more than ${megabytes(limit)}, ${NOT_SENT}`
      : `The images on this message are too large together, ${NOT_SENT}`,
  unsupportedType: ({ agentName }) =>
    `${agentName ?? 'The agent'} accepts only PNG, JPEG, GIF, and WebP images, so this message was not sent.`,
  notAFile: () => `An image on this message isn't a file, ${NOT_SENT}`,
  noSource: () => `An image on this message has no file to send, ${NOT_SENT}`
} satisfies Record<
  AgentSessionAttachmentProblemReason,
  (context: AgentSessionFailureWordsContext, problem: AgentSessionAttachmentProblem) => string
>

const FAILURE_SENTENCES = {
  providerStartFailed: () => 'The provider stopped before it finished starting.',
  startFailed: couldNot('start'),
  notSignedIn: ({ agentName }) =>
    `${agentName ?? 'The agent'} is not signed in for the selected account. Sign in, then send your message again.`,
  historyTooLarge: () =>
    "This conversation's history is too large to restore here. Start a new chat to continue.",
  providerExited: (_, __, surface) =>
    surface === 'row'
      ? 'The provider stopped while this response was in progress. You can continue in this conversation.'
      : 'The provider stopped before this message was sent.',
  restartFailed: couldNot('restart'),
  providerRejected: (_, fact) =>
    quotingPersonDetail('The provider did not accept this message', fact.detail),
  attachmentInvalid: (context, fact) =>
    fact.attachment
      ? ATTACHMENT_SENTENCES[fact.attachment.reason](context, fact.attachment)
      : "An attachment on this message can't be sent to the agent.",
  attachmentUnreadable: () => `An attachment on this message couldn't be read, ${NOT_SENT}`,
  emptyMessage: () => 'This message is empty, so it was not sent.',
  queueFull: () => 'Too many messages were waiting for the agent, so this one was not sent.',
  writeFailed: () => "Orca couldn't hand this message to the agent, so it was not sent.",
  cancelled: () => 'This message was withdrawn before the agent started it.',
  chatClosed: () => 'The chat closed before this message was sent.',
  hostRestarted: () => 'Orca restarted before this message was sent.',
  notDelivered: () => 'This message was not delivered. Send it again to continue.',
  compactionFailed: (_, fact) => quotingPersonDetail('Compaction failed', fact.detail),
  compactionUnconfirmed: () => 'Compaction completion is unconfirmed.',
  cancelUnconfirmed: () => 'Cancellation was not confirmed.',
  answerUnconfirmed: () => 'Your answer was recorded but the agent did not confirm it.',
  hostFault: () => "Orca ran into a problem, so this didn't go through. Try again."
} satisfies Record<AgentSessionFailureKind, Sentence>

/** The sentence a person reads for this fact on this surface; never a marker. */
export function agentSessionFailureSentence(
  fact: AgentSessionFailureFact,
  surface: AgentSessionFailureSurface,
  context: AgentSessionFailureWordsContext = {}
): string {
  const sentence: Sentence = FAILURE_SENTENCES[fact.kind]
  return sentence(context, fact, surface)
}

/** The markers released clients hide, for the rejections that had one before rows carried a fact.
 *  A write failure is the bare marker: its error belongs in the log. */
const LEGACY_REJECTION_MARKERS: Partial<
  Record<AgentSessionFailureKind, (context: AgentSessionFailureWordsContext) => string | undefined>
> = {
  cancelled: () => DISPATCH_REJECTED_CANCELLED,
  writeFailed: () => DISPATCH_REJECTED_WRITE_FAILED,
  queueFull: ({ provider }) =>
    provider === 'codex'
      ? DISPATCH_REJECTED_CODEX_QUEUE_FULL
      : provider === 'claude'
        ? DISPATCH_REJECTED_QUEUE_FULL
        : undefined
}

/** The words a status row reporting this fact records. */
export function agentSessionFailureWords(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext & { surface: 'row' }
): AgentSessionFailureRowWords
/** The words a message rejected for this fact records. */
export function agentSessionFailureWords(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext & { surface: 'rejection' }
): AgentJournalDispatchRejection
export function agentSessionFailureWords(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureWordsContext & { surface: AgentSessionFailureSurface }
): AgentSessionFailureRowWords | AgentJournalDispatchRejection {
  const words =
    (context.surface === 'rejection'
      ? LEGACY_REJECTION_MARKERS[fact.kind]?.(context)
      : undefined) ?? agentSessionFailureSentence(fact, context.surface, context)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the one constructor of the brand; `words` came from the table or a legacy marker for `fact`.
  const sentence = words as AgentSessionFailureSentence
  return context.surface === 'row'
    ? { text: sentence, failure: fact }
    : { reason: sentence, rejection: fact }
}

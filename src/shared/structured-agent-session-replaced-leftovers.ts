// What becomes of a message this window still held for a chat a /clear replaced. Text goes back to
// the composer only on proof the host never recorded it; a message in doubt is asked about again
// under its own id, and the host's answer decides.

import type { AgentSessionMutationResult, AgentSessionSendResult } from './agent-session-wire'
import type { AgentSessionWriteNoticeSentence } from './agent-session-write-notice-copy'
import {
  structuredAgentSessionEntryRejectedByHost,
  type StructuredAgentSessionOutboxEntry
} from './structured-agent-session-outbox'

/** Why the text came back: the clear refused it or it never left; another refusal; or the host
 *  could not say, and gave no answer that proves either way. */
export type ReplacedLeftoverCause = 'cleared' | 'notSent' | 'unconfirmed'

export type ReplacedLeftoverVerdict =
  /** The host holds it: its row in the old chat, its card or bubble in the new one. */
  | { kind: 'owned' }
  | { kind: 'handBack'; cause: ReplacedLeftoverCause }
  /** Sent, with no proving answer: asked again under its own id. */
  | { kind: 'inDoubt' }

function reasonOf(details: unknown): string | undefined {
  return typeof details === 'object' &&
    details !== null &&
    'reason' in details &&
    typeof details.reason === 'string'
    ? details.reason
    : undefined
}

function refusedAsCleared(refusal: { details?: unknown }): boolean {
  return reasonOf(refusal.details) === 'conversationCleared'
}

export function classifyReplacedLeftover(
  entry: StructuredAgentSessionOutboxEntry,
  ownedByHost: ReadonlySet<string>
): ReplacedLeftoverVerdict {
  if (ownedByHost.has(entry.clientMessageId) || structuredAgentSessionEntryRejectedByHost(entry)) {
    return { kind: 'owned' }
  }
  if (entry.lastAttemptAt === null) {
    // It never left this window, so the clear is why it never went out.
    return { kind: 'handBack', cause: 'cleared' }
  }
  if (entry.lastFailure?.kind === 'refused') {
    // A refusal the host returned proves it holds no message under that id.
    return { kind: 'handBack', cause: refusedAsCleared(entry.lastFailure) ? 'cleared' : 'notSent' }
  }
  return { kind: 'inDoubt' }
}

/** Answers that don't tell whether the message landed: only the chat could tell. */
const PROVES_NOTHING_CODES = new Set([
  'agent_session_operation_conflict',
  'agent_session_operation_expired'
])
const PROVES_NOTHING_REASONS = new Set(['messageIdReused', 'sessionNotAttached'])

/** The host's answer to asking again under the same id; `thrown` is no answer at all. */
export function resolveReplacedLeftover(
  answer: AgentSessionMutationResult<AgentSessionSendResult> | 'thrown'
): 'recorded' | 'askAgain' | { handBack: ReplacedLeftoverCause } {
  if (answer === 'thrown') {
    return 'askAgain'
  }
  if (answer.ok) {
    return 'recorded'
  }
  const { refusal } = answer
  if (refusal.code === 'agent_session_operation_unknown') {
    return 'askAgain'
  }
  const reason = reasonOf(refusal.details)
  if (PROVES_NOTHING_CODES.has(refusal.code) || (reason && PROVES_NOTHING_REASONS.has(reason))) {
    return { handBack: 'unconfirmed' }
  }
  return { handBack: refusedAsCleared(refusal) ? 'cleared' : 'notSent' }
}

const CAUSE_WORDS: Record<ReplacedLeftoverCause, AgentSessionWriteNoticeSentence[]> = {
  cleared: ['sentAsCleared'],
  notSent: ['notSentBackInComposer'],
  unconfirmed: ['sendOutcomeLost']
}

/** One line for what came back together: the most cautious cause among them. */
export function replacedLeftoverNotice(
  causes: readonly ReplacedLeftoverCause[]
): AgentSessionWriteNoticeSentence[] | null {
  for (const cause of ['unconfirmed', 'notSent', 'cleared'] as const) {
    if (causes.includes(cause)) {
      return CAUSE_WORDS[cause]
    }
  }
  return null
}

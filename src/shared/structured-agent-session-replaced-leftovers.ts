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

/** THE proof rule, for a refusal saved on a message and for one answering it again: whether it
 *  proves the host holds no message under that id, and why. Null when it proves nothing — the
 *  host can't tell yet, the id expired or holds another payload, or the chat isn't attached here;
 *  only asking again, or the chat, can tell then. */
export function refusalProvesUnrecorded(refusal: {
  code: string
  details?: unknown
}): ReplacedLeftoverCause | null {
  const reason = reasonOf(refusal.details)
  if (
    PROVES_NOTHING_CODES.has(refusal.code) ||
    (reason !== undefined && PROVES_NOTHING_REASONS.has(reason))
  ) {
    return null
  }
  return reason === 'conversationCleared' ? 'cleared' : 'notSent'
}

const PROVES_NOTHING_CODES = new Set([
  'agent_session_operation_unknown',
  'agent_session_operation_conflict',
  'agent_session_operation_expired'
])
const PROVES_NOTHING_REASONS = new Set(['messageIdReused', 'sessionNotAttached'])

export function classifyReplacedLeftover(
  entry: StructuredAgentSessionOutboxEntry,
  ownedByHost: ReadonlySet<string>
): ReplacedLeftoverVerdict {
  if (ownedByHost.has(entry.clientMessageId) || structuredAgentSessionEntryRejectedByHost(entry)) {
    return { kind: 'owned' }
  }
  // A saved failure's own cause decides before "never left": a refused first attempt is saved
  // under a fresh id that nothing has sent yet.
  const failure = entry.lastFailure
  if (failure?.kind === 'refused') {
    // Only a first attempt's refusal rotates the id, and only one that proves nothing landed.
    // Under a kept id an earlier attempt may have, so only asking again can tell.
    const cause = entry.lastAttemptAt === null ? refusalProvesUnrecorded(failure) : null
    return cause ? { kind: 'handBack', cause } : { kind: 'inDoubt' }
  }
  if (failure?.kind === 'failed') {
    // It failed before the host ran it: a save that failed, or a request never written.
    return { kind: 'handBack', cause: 'notSent' }
  }
  if (failure === undefined && entry.lastAttemptAt === null) {
    // It never left this window, so the clear is why it never went out.
    return { kind: 'handBack', cause: 'cleared' }
  }
  return { kind: 'inDoubt' }
}

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
  const cause = refusalProvesUnrecorded(answer.refusal)
  return cause ? { handBack: cause } : 'askAgain'
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

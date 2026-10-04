// Mid-turn queueing: the accept decision that turns a send into a host-held
// draft, the gates the drain (`structured-agent-session-queued-drain.ts`)
// re-reads, and the draft budget.
//
// Drafts are never owed work: they feed no reducer, no working status, no
// teardown and no idle sweep.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  USER_MESSAGE_SOURCE,
  type AgentMessageSource
} from '../../../shared/agent-session-message-source'
import type {
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import { isUnsettledQueuedMessage } from '../agent-session-journal/queued-message-table'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import {
  structuredAgentSessionHostInstance,
  structuredQueuePauses
} from './structured-agent-session-queued-pause'
import { nextSendableQueuedCard } from '../agent-session-journal/queued-message-pause'

/** Budget at accept, in the send schema's own unit (`Buffer.byteLength` of the
 *  serialized blocks); refused readably rather than trimmed. */
export const QUEUED_MESSAGES_MAX_COUNT = 20
export const QUEUED_MESSAGES_MAX_TOTAL_BYTES = 1024 * 1024

/** Text-only v1: any image block routes to the immediate path. */
export function queuedMessageBodyIsTextOnly(body: AgentJournalMessageItem): boolean {
  return body.blocks.every((block) => block.type === 'text')
}

/** Walks the reduced items in place: the gate runs on every admission and
 *  drain step, so it must not render a snapshot of the whole journal. */
export function pendingPromptExists(journal: Pick<AgentSessionJournal, 'visitItems'>): boolean {
  let pending = false
  journal.visitItems((_itemId, _sequence, body) => {
    if (
      !pending &&
      (body.kind === 'approval' || body.kind === 'question') &&
      body.resolution.state === 'pending'
    ) {
      pending = true
    }
  })
  return pending
}

/** Waiting, not held on its own, and not positioned behind a returned card or a
 *  card the queue's pause holds: the queue never reorders. The admission rule
 *  (§accept) and the drain's selection both read it. */
export function oldestActionableQueuedMessage(
  journal: Pick<AgentSessionJournal, 'queuedMessages'>
): QueuedMessageRow | null {
  const rows = journal.queuedMessages.list()
  // Nothing waiting costs no pause derivation: this runs on every journal publish.
  if (!rows.some((row) => row.state === 'waiting')) {
    return null
  }
  return nextSendableQueuedCard(structuredQueuePauses(journal), rows)
}

/**
 * Why the queue is not sending right now — ONE decision for admission, the
 * drain step and Send-now, so the lists cannot drift. Each caller's override
 * policy sits next to its use:
 *
 *   admission: `blocked` refuses (the immediate path's own refusal); any other
 *     hold, or an actionable backlog, queues the send as a draft.
 *   drain step: any hold returns early; whatever clears it publishes or
 *     commits, which re-derives.
 *   Send-now: overrides only `working` (plus FIFO order and the stored hold);
 *     `blocked` and `prompt` refuse readably.
 *
 * `blocked` is whatever refuses any send (an uncertain rewind, a cleared source);
 * the rest are waits. A /compact is a queued message and then a turn,
 * so it holds the queue as `working`; an older build's compaction record belongs
 * to a child this host no longer runs and holds nothing. Host-local vocabulary —
 * never on the wire.
 */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

export function structuredQueueHold(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  fence: number
}): StructuredQueueHold | null {
  // Whatever refuses any send refuses the queue too: an uncertain rewind or a source a
  // clear superseded. One rule, the immediate path's own.
  if (structuredAgentSessionSendBlock(input.record)) {
    return 'blocked'
  }
  const { journal } = input
  // `prompt` outranks `working`: it is the one wait Send-now may not override,
  // so a prompt raised mid-turn must not read as merely `working`.
  if (pendingPromptExists(journal)) {
    return 'prompt'
  }
  if (
    isStructuredAgentSessionMainAgentWorking(
      journal.activeTurnId(),
      journal.submissions(),
      input.fence
    )
  ) {
    return 'working'
  }
  return null
}

/**
 * Whether a `queue-if-active` send becomes a draft: any queue hold short of
 * `blocked`, or an actionable draft already exists (FIFO backlog — an
 * ADMISSION rule only, never a drain gate). A lone returned card, or a paused
 * queue, does not trap a new send: the user acting now wins, and that send's
 * turn starting is what lifts the pause — Orca's own queue policy, a stated
 * deviation from held-head backlog counting.
 */
export function shouldQueueStructuredAgentSessionSend(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  fence: number
}): boolean {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // The immediate path's own refusal (`structuredAgentSessionSendBlock`)
    // answers; queueing behind a fence would strand the draft.
    return false
  }
  if (hold !== null) {
    return true
  }
  return oldestActionableQueuedMessage(input.journal) !== null
}

/** A draft's payload fingerprint in the session that will send it: the reducer
 *  aliases the provider's echo to the submission by recomputing exactly this. */
export function queuedMessageFingerprint(sessionId: string, body: AgentJournalMessageItem): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId,
    fields: { body }
  })
}

/** The accept-side budget refusal, or null when the draft fits. */
export function queuedMessageBudgetRefusal(
  journal: AgentSessionJournal,
  body: AgentJournalMessageItem
): AgentSessionWireRefusal | null {
  const unsettled = journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
  const bytes = unsettled.reduce(
    (sum, row) => sum + Buffer.byteLength(JSON.stringify(row.body.blocks), 'utf8'),
    Buffer.byteLength(JSON.stringify(body.blocks), 'utf8')
  )
  if (unsettled.length >= QUEUED_MESSAGES_MAX_COUNT || bytes > QUEUED_MESSAGES_MAX_TOTAL_BYTES) {
    return {
      code: 'agent_session_operation_invalid',
      message: 'The message queue is full. Send again after the current turn ends.'
    }
  }
  return null
}

/**
 * The accept branch: a capable send while the session is working (or behind an
 * actionable backlog) becomes a draft instead of a submission. Returns null for
 * the immediate path — an incapable client, an image body (text-only v1), a
 * replayed id the journal already answers, or an idle session.
 */
export async function maybeQueueStructuredAgentSessionSend(
  context: {
    deps: { store: { getRecord: (sessionId: string) => AgentSessionRecord | null } }
  },
  ctx: {
    sessionId: string
    journal: AgentSessionJournal
    fence: number
  },
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    /** A person's send at a chat surface; it outranks any `source`. */
    userSend?: true
    /** Who Orca is queueing for, on a host-side send. */
    source?: AgentMessageSource
  }
): Promise<
  | { ok: true; value: AgentSessionSendResult }
  | { ok: false; refusal: AgentSessionWireRefusal }
  | null
> {
  const clientMessageId = params.envelope.clientOperationId
  if (params.delivery !== 'queue-if-active' || !queuedMessageBodyIsTextOnly(params.body)) {
    return null
  }
  // Asked again with no ledger answer: a send this host queued answers as its replay would —
  // its hand-off goes out under a fresh id, so no submission under this id guards it.
  const queuedBefore = queuedSendAnswer(ctx.journal, clientMessageId)
  if (queuedBefore) {
    return { ok: true, value: queuedBefore }
  }
  // A recorded direct submission under this id replays through today's path.
  if (ctx.journal.submissions().some((entry) => entry.clientMessageId === clientMessageId)) {
    return null
  }
  // A newer Orca's journal takes no new draft: the immediate path refuses the send.
  if (
    ctx.journal.isReadOnly ||
    !shouldQueueStructuredAgentSessionSend({
      journal: ctx.journal,
      record: context.deps.store.getRecord(ctx.sessionId),
      fence: ctx.fence
    })
  ) {
    return null
  }
  const refusal = queuedMessageBudgetRefusal(ctx.journal, params.body)
  if (refusal) {
    return { ok: false, refusal }
  }
  // The insert notifies through the journal's commit listener: publication and
  // the drain re-derive with no call here to forget.
  const row = await ctx.journal.queuedMessages.insert({
    messageId: clientMessageId,
    body: params.body,
    fingerprint: queuedMessageFingerprint(ctx.sessionId, params.body),
    hostInstance: structuredAgentSessionHostInstance(),
    // A host-side send that names no sender holds after a restart, as every card did before.
    source: params.userSend ? USER_MESSAGE_SOURCE : (params.source ?? USER_MESSAGE_SOURCE)
  })
  return {
    ok: true,
    value: {
      clientMessageId,
      queued: { messageId: row.messageId, position: row.position, state: row.state }
    }
  }
}

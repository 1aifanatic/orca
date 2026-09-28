// Mid-turn queueing: the accept decision that turns a send into a host-held
// draft, the serialized drain that converts one draft into an ordinary
// submission when the session stops owing work, and the published draft list.
//
// Drafts are never owed work: they feed no reducer, no working status, no
// teardown and no idle sweep. The drain re-reads every gate inside its own
// serialized step, so there is no loop state to disagree with the journal.

import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import {
  pauseQueuedMessage,
  queuedMessageHeld,
  structuredAgentSessionHostInstance
} from './structured-agent-session-queued-pause'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'

/** Budget at accept, in the send schema's own unit (`Buffer.byteLength` of the
 *  serialized blocks); refused readably rather than trimmed. */
export const QUEUED_MESSAGES_MAX_COUNT = 20
export const QUEUED_MESSAGES_MAX_TOTAL_BYTES = 1024 * 1024

/** Text-only v1: any image block routes to the immediate path. */
export function queuedMessageBodyIsTextOnly(body: AgentJournalMessageItem): boolean {
  return body.blocks.every((block) => block.type === 'text')
}

export function pendingPromptExists(items: Iterable<AgentJournalRenderItem>): boolean {
  for (const item of items) {
    const body = item.body
    if (
      (body.kind === 'approval' || body.kind === 'question') &&
      body.resolution.state === 'pending'
    ) {
      return true
    }
  }
  return false
}

/** Waiting, unpaused, and not positioned behind a returned card. The admission
 *  rule (§accept) and the drain's selection both read it. */
function oldestActionableQueuedMessage(rows: readonly QueuedMessageRow[]): QueuedMessageRow | null {
  for (const row of rows) {
    if (row.state === 'returned') {
      // A returned card blocks everything after it until the user acts.
      return null
    }
    if (row.state !== 'waiting') {
      continue
    }
    if (queuedMessageHeld(row)) {
      continue
    }
    return row
  }
  return null
}

/**
 * Whether a `queue-if-active` send becomes a draft: the session owes work, a
 * prompt waits on the user, a conversation command is prepared or in doubt, or
 * an actionable draft already exists (FIFO backlog — an ADMISSION rule only,
 * never a drain gate). A lone returned card, or only paused drafts, does not
 * trap a new send: the user acting now wins — Orca's own queue policy, a stated
 * deviation from held-head backlog counting.
 */
export function shouldQueueStructuredAgentSessionSend(input: {
  journal: AgentSessionJournal
  record: AgentSessionRecord | null
  fence: number
}): boolean {
  const { journal } = input
  if (
    isStructuredAgentSessionMainAgentWorking(
      journal.activeTurnId(),
      journal.submissions(),
      input.fence
    )
  ) {
    return true
  }
  if (pendingPromptExists(journal.snapshot().items)) {
    return true
  }
  // A prepared /clear or /compact is in flight; its settlement wakes the drain.
  if (input.record?.conversationCommand?.phase === 'prepared') {
    return true
  }
  return oldestActionableQueuedMessage(journal.queuedMessages.list()) !== null
}

/** The accept-side budget refusal, or null when the draft fits. */
export function queuedMessageBudgetRefusal(
  journal: AgentSessionJournal,
  body: AgentJournalMessageItem
): AgentSessionWireRefusal | null {
  const unsettled = journal.queuedMessages
    .list()
    .filter((row) => row.state === 'waiting' || row.state === 'returned')
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
    wakeQueuedDrain?: (sessionId: string) => void
  },
  ctx: {
    sessionId: string
    journal: AgentSessionJournal
    fence: number
    publish: () => void
  },
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
  }
): Promise<
  | {
      ok: true
      value: {
        clientMessageId: string
        queued: { messageId: string; position: number; state: QueuedMessageRow['state'] }
      }
    }
  | { ok: false; refusal: AgentSessionWireRefusal }
  | null
> {
  const clientMessageId = params.envelope.clientOperationId
  if (params.delivery !== 'queue-if-active' || !queuedMessageBodyIsTextOnly(params.body)) {
    return null
  }
  // A recorded submission under this id replays through today's path.
  if (ctx.journal.submissions().some((entry) => entry.clientMessageId === clientMessageId)) {
    return null
  }
  if (
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
  const row = await ctx.journal.queuedMessages.insert({
    messageId: clientMessageId,
    body: params.body,
    fingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: ctx.sessionId,
      fields: { body: params.body }
    }),
    hostInstance: structuredAgentSessionHostInstance()
  })
  // A draft writes no journal row, so publish explicitly; the caught-up path
  // detects the changed list.
  ctx.publish()
  context.wakeQueuedDrain?.(ctx.sessionId)
  return {
    ok: true,
    value: {
      clientMessageId,
      queued: { messageId: row.messageId, position: row.position, state: row.state }
    }
  }
}

export type QueuedMessageDrainDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The streamed-event barrier: a turn-open already accepted by the host is
   *  committed before the gates are read, so no stored busy flag is needed. */
  flushStreamedEvents: (sessionId: string) => Promise<void>
  conversationFence: (sessionId: string) => number
  /** The consumed submission is ordinary #22821 work from here on. */
  wakeDelivery: (sessionId: string) => void
  onError: (sessionId: string, error: unknown) => void
}

/**
 * The serialized drain. Woken by every journal commit (turn, submission, prompt,
 * command and Stop settlements are all commits), by draft mutations, and by the
 * conversation opening; each step re-derives everything and consumes at most one
 * draft — the consumed submission then owes work, which gates the next.
 */
export class StructuredAgentSessionQueuedMessageDrain {
  private readonly scheduled = new Set<string>()

  constructor(private readonly deps: QueuedMessageDrainDeps) {}

  schedule(sessionId: string): void {
    const journal = this.deps.sessions.get(sessionId)?.journal
    if (!journal || journal.isReadOnly) {
      return
    }
    // Cheap pre-check so token streams do not pay a serialized step per delta.
    try {
      if (oldestActionableQueuedMessage(journal.queuedMessages.list()) === null) {
        return
      }
    } catch {
      // The handle is opening or closing; the next commit re-schedules.
      return
    }
    if (this.scheduled.has(sessionId)) {
      return
    }
    this.scheduled.add(sessionId)
    void this.deps
      .serialize(sessionId, () => {
        this.scheduled.delete(sessionId)
        return this.step(sessionId)
      })
      .catch((error: unknown) => {
        this.scheduled.delete(sessionId)
        this.deps.onError(sessionId, error)
      })
  }

  private async step(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (!session || session.journal.isReadOnly) {
      return
    }
    await this.deps.flushStreamedEvents(sessionId)
    const journal = session.journal
    const next = oldestActionableQueuedMessage(journal.queuedMessages.list())
    if (!next) {
      return
    }
    const record = this.deps.getRecord(sessionId)
    const fence = this.deps.conversationFence(sessionId)
    // Live facts only; the backlog is never a gate, so a lone draft drains.
    if (
      structuredAgentSessionSendBlock(record) !== null ||
      isStructuredAgentSessionMainAgentWorking(
        journal.activeTurnId(),
        journal.submissions(),
        fence
      ) ||
      pendingPromptExists(journal.snapshot().items) ||
      record?.conversationCommand?.phase === 'prepared'
    ) {
      return
    }
    try {
      await journal.appendSubmission(
        {
          clientMessageId: next.messageId,
          payloadFingerprint: next.fingerprint,
          body: next.body,
          fence,
          handoverRecorded: true
        },
        { messageId: next.messageId, expect: 'waiting', settledByOp: null }
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
        // Lost a race with a Send-now, Delete or Stop; their transition stands.
        return
      }
      // Pre-consume failure: the draft stays waiting, held with the error on the
      // card. An explicit Send retries; no automatic retry loop.
      pauseQueuedMessage(sessionId, next.messageId, "Couldn't send — press Send to retry.")
      throw error
    }
    this.deps.wakeDelivery(sessionId)
  }
}

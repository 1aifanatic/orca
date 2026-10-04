import type { AgentSessionFailureFact } from './agent-session-failure'
import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import { agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalCursor,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from './agent-session-journal-types'
import type { AgentSessionWriteFailure } from './agent-session-write-failure'
import { dispatchWasWithdrawn } from './structured-agent-session-dispatch-rejection'
import {
  structuredAgentSessionMessageSendMutation,
  type StructuredAgentSessionSendMutation
} from './structured-agent-session-send-mutation'
import { parseStructuredAgentSessionOutboxQueueFields } from './structured-agent-session-outbox-delivery'

/** `queued`: waits to go out. `dispatching`: out, or held by the host as a row it has not handed
 *  to the agent yet. `unconfirmed`: no answer yet, so the same id goes again
 *  (structured-agent-session-outbox-settlement). */
export type StructuredAgentSessionOutboxState = 'queued' | 'dispatching' | 'unconfirmed'

/** The Stop that outran a send already on its way: by its own id, and where the host's journal
 *  stood when it answered. */
export type StructuredAgentSessionOutboxStop = {
  operationId: string
  cursor?: AgentJournalCursor
  /** The Stop was refused, or can't be sent again without stopping something newer. */
  unanswerable?: true
}

export type StructuredAgentSessionOutboxEntry = {
  clientMessageId: string
  sessionId: string
  body: AgentJournalMessageItem
  previewUris: string[]
  /** Each image's SSH connection, by its place among the message's images (null: local). Kept so
   *  an image handed back still opens on its remote host; never sent, the host reads paths. */
  attachmentConnectionIds?: (string | null)[]
  state: StructuredAgentSessionOutboxState
  queuedAt: number
  lastAttemptAt: number | null
  source?: 'launch'
  /** A Stop was pressed while this send was out. It never goes again, since a resend onto the
   *  session the user stopped could start a turn; its own answer, its journal row or the Stop's
   *  answer settles it. */
  stoppedBy?: StructuredAgentSessionOutboxStop
  /** Saved by an older build that held it for a Retry this build no longer has: it never goes out
   *  again on its own (the person was told it did not go), and the journal settles it once loaded. */
  legacyUnsettled?: true
  /** The notes the message was built from, by their send keys: they stay off the shelf while this
   *  client still holds the message, reload included, and are cleared once the host has it. */
  carriedNoteKeys?: string[]
  /** Whether the first attempt asked the host to hold it as a draft (`null`: plain); every replay
   *  of this id asks the same (structured-agent-session-outbox-delivery). On a request's own copy,
   *  what that request carries. */
  sentDelivery?: 'queue-if-active' | null
}

/** A host's rejection fact as a message keeps it: never its provider detail, whose log text is not
 *  kept client-side, or its refusal. The journal row keeps the whole fact, and words the notice
 *  while it is loaded; this copy words it when it is not. */
export type StructuredAgentSessionRejectionFact = Pick<
  AgentSessionFailureFact,
  'kind' | 'attachment'
>

/** Why a write did not go through, kept as the fact; the words are chosen where it is shown. */
export type StructuredAgentSessionAttemptFailure =
  | AgentSessionWriteFailure
  /** The host recorded the message and the provider turned it down, with the provider's reason. */
  | { kind: 'rejected'; reason: string | null; rejection?: StructuredAgentSessionRejectionFact }

/** The failure a rejected submission leaves on its message. A fact this build cannot read whole is
 *  dropped, leaving the reason. */
export function structuredAgentSessionRejectedFailure(submission: {
  reason: string | null
  rejection?: unknown
}): Extract<StructuredAgentSessionAttemptFailure, { kind: 'rejected' }> {
  const fact = readWholeAgentSessionFailureFact(submission.rejection)
  return {
    kind: 'rejected',
    reason: submission.reason,
    ...(fact
      ? {
          rejection: {
            kind: fact.kind,
            ...(fact.attachment ? { attachment: fact.attachment } : {})
          }
        }
      : {})
  }
}

export type StructuredAgentSessionAttachment = {
  path: string
  previewUri: string
  /** The SSH connection the image was uploaded to, for a remote workspace. */
  connectionId?: string
}

export function structuredAgentSessionSendBody(
  text: string,
  attachments: readonly StructuredAgentSessionAttachment[]
): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [
      ...(text.trim().length > 0 ? [{ type: 'text' as const, text: text.trimEnd() }] : []),
      ...attachments.map((attachment) => ({ type: 'image-ref' as const, path: attachment.path }))
    ]
  }
}

export function createStructuredAgentSessionOutboxEntry(args: {
  clientMessageId: string
  sessionId: string
  text: string
  attachments: readonly StructuredAgentSessionAttachment[]
  queuedAt: number
}): StructuredAgentSessionOutboxEntry {
  return {
    clientMessageId: args.clientMessageId,
    sessionId: args.sessionId,
    body: structuredAgentSessionSendBody(args.text, args.attachments),
    previewUris: args.attachments.map((attachment) => attachment.previewUri),
    ...(args.attachments.some((attachment) => attachment.connectionId)
      ? {
          attachmentConnectionIds: args.attachments.map(
            (attachment) => attachment.connectionId ?? null
          )
        }
      : {}),
    state: 'queued',
    queuedAt: args.queuedAt,
    lastAttemptAt: null
  }
}

export function updateStructuredAgentSessionOutboxEntry(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  id: string,
  update: (entry: StructuredAgentSessionOutboxEntry) => StructuredAgentSessionOutboxEntry | null
): StructuredAgentSessionOutboxEntry[] {
  return entries.flatMap((entry) => {
    if (entry.clientMessageId !== id) {
      return [entry]
    }
    const next = update(entry)
    return next ? [next] : []
  })
}

export function stageStructuredAgentSessionOutboxEntryForSend(
  entry: StructuredAgentSessionOutboxEntry,
  now: number
): StructuredAgentSessionOutboxEntry {
  return { ...entry, state: 'dispatching', lastAttemptAt: now }
}

/** The host recorded this send and then rejected it, and this client has not loaded the row: the
 *  entry draws the message until it does. An older host leaves that row where the message was
 *  sent, which may be on a page not loaded; a newer one moves it to the rejection. */
export function structuredAgentSessionRejectionAwaitsItsRow(
  submission: Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'rejection'>,
  rowLoaded: boolean
): boolean {
  return submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission) && !rowLoaded
}

/** Whether any entry still owes a delivery: one the host recorded and then rejected owes none, and
 *  only waits for its row to load. */
export function structuredAgentSessionOutboxOwesDelivery(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[]
): boolean {
  if (entries.length === 0) {
    return false
  }
  const rejected = new Set(
    submissions
      .filter((submission) => submission.dispatchState === 'rejected')
      .map((submission) => submission.clientMessageId)
  )
  return entries.some((entry) => !rejected.has(entry.clientMessageId))
}

/**
 * The outbox as the journal reads it: an entry the host holds a row for leaves once that row has
 * settled and is loaded (the row shows it from there), and stays out while it is pending. A view's
 * reading; the outbox hook settles the stored copy (structured-agent-session-outbox-settlement).
 * Returns `entries` itself when it changes nothing.
 */
export function reconcileStructuredAgentSessionOutbox(
  entries: readonly StructuredAgentSessionOutboxEntry[],
  submissions: readonly AgentJournalSubmission[],
  /** The loaded journal rows. */
  items: readonly AgentJournalRenderItem[]
): readonly StructuredAgentSessionOutboxEntry[] {
  const rows = new Map(submissions.map((entry) => [entry.clientMessageId, entry]))
  let loaded: Set<string> | undefined
  const next = entries.flatMap((entry) => {
    const submission = rows.get(entry.clientMessageId)
    if (!submission) {
      return [entry]
    }
    if (submission.dispatchState === 'pending') {
      return entry.state === 'dispatching' ? [entry] : [{ ...entry, state: 'dispatching' as const }]
    }
    loaded ??= new Set(items.map((item) => item.itemId))
    const rowLoaded = loaded.has(agentJournalSubmissionKey(entry.clientMessageId))
    return structuredAgentSessionRejectionAwaitsItsRow(submission, rowLoaded) ? [entry] : []
  })
  return next.length === entries.length && next.every((entry, index) => entry === entries[index])
    ? entries
    : next
}

export function parseStructuredAgentSessionOutboxEntry(
  value: unknown,
  sessionId: string
): StructuredAgentSessionOutboxEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as Partial<StructuredAgentSessionOutboxEntry>
  const body = entry.body
  if (
    entry.sessionId !== sessionId ||
    typeof entry.clientMessageId !== 'string' ||
    typeof entry.queuedAt !== 'number' ||
    !body ||
    body.kind !== 'message' ||
    body.role !== 'user' ||
    !Array.isArray(body.blocks) ||
    !Array.isArray(entry.previewUris) ||
    !entry.previewUris.every((uri) => typeof uri === 'string')
  ) {
    return null
  }
  const saved: Record<string, unknown> = { ...entry }
  // `rejected` is an older build's: read as queued and never sent again (below).
  const state = saved.state === 'rejected' ? 'queued' : saved.state
  if (state !== 'queued' && state !== 'dispatching' && state !== 'unconfirmed') {
    return null
  }
  // Older builds held these for a Retry: a rejected one, one with a saved failure, one a Stop
  // outlived. Read as they were left, never sent again.
  const legacyUnsettled =
    saved.legacyUnsettled === true ||
    saved.state === 'rejected' ||
    (state === 'queued' && saved.lastFailure !== undefined) ||
    saved.outlivedStop === true
  const stoppedBy = parseStructuredAgentSessionOutboxStop(saved.stoppedBy)
  return {
    clientMessageId: entry.clientMessageId,
    sessionId,
    body,
    previewUris: entry.previewUris,
    ...(Array.isArray(saved.attachmentConnectionIds) &&
    saved.attachmentConnectionIds.every((id) => id === null || typeof id === 'string')
      ? { attachmentConnectionIds: saved.attachmentConnectionIds }
      : {}),
    state,
    queuedAt: entry.queuedAt,
    lastAttemptAt: typeof entry.lastAttemptAt === 'number' ? entry.lastAttemptAt : null,
    ...(entry.source === 'launch' ? { source: 'launch' as const } : {}),
    ...parseStructuredAgentSessionOutboxQueueFields(entry),
    ...(stoppedBy ? { stoppedBy } : {}),
    ...(legacyUnsettled ? { legacyUnsettled: true as const } : {}),
    ...(Array.isArray(saved.carriedNoteKeys) &&
    saved.carriedNoteKeys.length > 0 &&
    saved.carriedNoteKeys.every((key) => typeof key === 'string')
      ? { carriedNoteKeys: saved.carriedNoteKeys }
      : {})
  }
}

function parseStructuredAgentSessionOutboxStop(
  value: unknown
): StructuredAgentSessionOutboxStop | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const stop: Record<string, unknown> = { ...value }
  if (typeof stop.operationId !== 'string') {
    return undefined
  }
  const cursor: Record<string, unknown> | null =
    typeof stop.cursor === 'object' && stop.cursor !== null ? { ...stop.cursor } : null
  return {
    operationId: stop.operationId,
    ...(cursor && typeof cursor.epoch === 'string' && typeof cursor.sequence === 'number'
      ? { cursor: { epoch: cursor.epoch, sequence: cursor.sequence } }
      : {}),
    ...(stop.unanswerable === true ? { unanswerable: true as const } : {})
  }
}

/** The `agentSession.send` arguments an entry stands for. */
export function structuredAgentSessionSendMutation(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): StructuredAgentSessionSendMutation {
  return structuredAgentSessionMessageSendMutation({
    sessionId: entry.sessionId,
    clientOperationId: entry.clientMessageId,
    expectedRuntimeFence,
    body: entry.body,
    delivery: entry.sentDelivery ?? undefined
  })
}

export function structuredAgentSessionSendRequest(
  entry: StructuredAgentSessionOutboxEntry,
  expectedRuntimeFence: number
): Record<string, unknown> {
  return structuredAgentSessionSendMutation(entry, expectedRuntimeFence)
}

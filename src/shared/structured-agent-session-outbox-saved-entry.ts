// An outbox entry as a saved copy reads back: this build's fields, and what older builds left, mapped
// onto what this build does with it.

import { readWholeAgentSessionFailureFact } from './agent-session-failure'
import type {
  StructuredAgentSessionOutboxEntry,
  StructuredAgentSessionOutboxStop,
  StructuredAgentSessionRecordedRejection
} from './structured-agent-session-outbox'
import { parseStructuredAgentSessionOutboxQueueFields } from './structured-agent-session-outbox-delivery'

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
  // A copy the build before this one kept as the host rejected it is that host fact.
  const recordedRejection =
    parseStructuredAgentSessionRecordedRejection(saved.recordedRejection) ??
    (saved.state === 'rejected' ? parseOlderBuildRecordedRejection(saved.lastFailure) : undefined)
  // `rejected` is an older build's: read as queued and never sent again (below).
  const state = saved.state === 'rejected' ? 'queued' : saved.state
  if (state !== 'queued' && state !== 'dispatching' && state !== 'unconfirmed') {
    return null
  }
  // Older builds held these for a Retry: a rejected one, one with a saved failure, one a Stop
  // outlived. Read as they were left, never sent again.
  const legacyUnsettled =
    recordedRejection === undefined &&
    (saved.legacyUnsettled === true ||
      saved.state === 'rejected' ||
      (state === 'queued' && saved.lastFailure !== undefined) ||
      saved.outlivedStop === true)
  const stoppedBy = parseStructuredAgentSessionOutboxStop(saved.stoppedBy)
  const returning = parseStructuredAgentSessionOutboxReturning(saved.returning)
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
    ...(returning ? { returning } : {}),
    ...(recordedRejection ? { recordedRejection } : {}),
    ...(legacyUnsettled ? { legacyUnsettled: true as const } : {}),
    ...(Array.isArray(saved.carriedNoteKeys) &&
    saved.carriedNoteKeys.length > 0 &&
    saved.carriedNoteKeys.every((key) => typeof key === 'string')
      ? { carriedNoteKeys: saved.carriedNoteKeys }
      : {})
  }
}

function parseStructuredAgentSessionRecordedRejection(
  value: unknown
): StructuredAgentSessionRecordedRejection | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const saved: Record<string, unknown> = { ...value }
  const reason = typeof saved.reason === 'string' ? saved.reason : null
  const fact = readWholeAgentSessionFailureFact(saved.rejection)
  return {
    reason,
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

/** An older build's `rejected` entry whose failure was the host's own rejection. */
function parseOlderBuildRecordedRejection(
  lastFailure: unknown
): StructuredAgentSessionRecordedRejection | undefined {
  if (typeof lastFailure !== 'object' || lastFailure === null) {
    return undefined
  }
  const failure: Record<string, unknown> = { ...lastFailure }
  return failure.kind === 'rejected'
    ? parseStructuredAgentSessionRecordedRejection(failure)
    : undefined
}

function parseStructuredAgentSessionOutboxReturning(
  value: unknown
): StructuredAgentSessionOutboxEntry['returning'] {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const returning: Record<string, unknown> = { ...value }
  // An ending this build doesn't know still hands the text back, which is what keeps it.
  return { ending: returning.ending === 'discarded' ? 'discarded' : 'returned' }
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

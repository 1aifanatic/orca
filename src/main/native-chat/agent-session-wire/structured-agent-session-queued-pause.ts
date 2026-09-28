// The queued-draft pause set, owned at HOST-PROCESS level — never on the
// session/handle object, which the idle sweep deletes on close: Stop → evict →
// reopen in the same process must still hold the pause. Restart is covered by
// each draft's `host_instance` differing from this process's instance id.

import { randomUUID } from 'node:crypto'

/** A per-process id, minted once per host process like the runtime's own
 *  `runtimeId` (`orca-runtime-runtime-id.ts`); a draft written by another
 *  instance publishes as paused rather than auto-sending after a restart. */
let hostInstance = randomUUID()

export function structuredAgentSessionHostInstance(): string {
  return hostInstance
}

/** Simulates a host-process restart. Tests only. */
export function rotateStructuredAgentSessionHostInstanceForTests(): string {
  hostInstance = randomUUID()
  return hostInstance
}

type QueuedMessagePause = {
  /** Copy for the card when the hold came from a failure; a Stop's pause has none. */
  reason?: string
}

/** NUL cannot occur in either id, so no pair can forge another pair's key. */
const PAUSE_KEY_SEPARATOR = '\u0000'

const pausedDrafts = new Map<string, QueuedMessagePause>()
/** Bumped on every pause change so publication memos recompute only when they must. */
let pauseRevision = 0

function pauseKey(sessionId: string, messageId: string): string {
  return `${sessionId}${PAUSE_KEY_SEPARATOR}${messageId}`
}

export function pauseQueuedMessage(sessionId: string, messageId: string, reason?: string): void {
  pausedDrafts.set(pauseKey(sessionId, messageId), reason === undefined ? {} : { reason })
  pauseRevision++
}

/** Cleared on consume, withdraw, and delete — the transitions that retire the hold. */
export function releaseQueuedMessagePause(sessionId: string, messageId: string): void {
  if (pausedDrafts.delete(pauseKey(sessionId, messageId))) {
    pauseRevision++
  }
}

export function queuedMessagePause(
  sessionId: string,
  messageId: string
): QueuedMessagePause | undefined {
  return pausedDrafts.get(pauseKey(sessionId, messageId))
}

export function queuedMessagePauseRevision(): number {
  return pauseRevision
}

/** Held from auto-sending: a pause in this process, or written by another host
 *  instance (a restart) — derived at read time, never stored. */
export function queuedMessageHeld(row: {
  sessionId: string
  messageId: string
  hostInstance: string
}): boolean {
  return (
    queuedMessagePause(row.sessionId, row.messageId) !== undefined ||
    row.hostInstance !== hostInstance
  )
}

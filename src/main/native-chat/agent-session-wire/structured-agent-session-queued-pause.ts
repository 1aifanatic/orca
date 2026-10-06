// Whether the queue is paused, and why — derived from the journal and the cards
// (`queued-message-pause.ts`), never stored. A Stop's event, a Resume and a reopen that found
// waiting cards are journal rows; an explicit Resume lifts any pause.

import { randomUUID } from 'node:crypto'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { DerivedQueuePause } from '../agent-session-journal/queued-message-pause'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** A per-process id, minted once per host process like the runtime's own
 *  `runtimeId` (`orca-runtime-runtime-id.ts`), stamped on the cards this process writes or hands
 *  off. No pause reads it: an older build holds every card another instance wrote. */
let hostInstance = randomUUID()
/** Per host, keyed by its open-conversations map: the conversations it has opened and marked (or
 *  found nothing to mark). A later open is the idle sweep's eviction coming back, which the person
 *  never saw, so it marks nothing. A failed mark leaves its conversation out, so the next open
 *  tries again. In memory, so a new host process marks again. */
const openedHere = new WeakMap<HostConversations, Set<string>>()

type HostConversations = ReadonlyMap<string, unknown>

function openedBy(sessions: HostConversations): Set<string> {
  let opened = openedHere.get(sessions)
  if (!opened) {
    opened = new Set()
    openedHere.set(sessions, opened)
  }
  return opened
}

export function structuredAgentSessionHostInstance(): string {
  return hostInstance
}

/** Simulates a host-process restart. Tests only. */
export function rotateStructuredAgentSessionHostInstanceForTests(): string {
  hostInstance = randomUUID()
  return hostInstance
}

type PauseJournal = Pick<AgentSessionJournal, 'queuedMessages'>

/** The queue's pauses in force, derived; none when the queue sends on its own. */
export function structuredQueuePauses(journal: PauseJournal): DerivedQueuePause[] {
  return journal.queuedMessages.pauses()
}

/** The mark of a chat that stopped running with cards waiting — Orca quit or crashed, or the chat
 *  was closed — so they wait for its next turn (`queued-message-pause.ts`). Bookkeeping, so a
 *  failure is reported and never thrown; the pause then starts at the open itself, holding no
 *  less. Resolves whether it marked, or found nothing to mark. */
export async function markStructuredQueueReopen(
  host: { sessions: HostConversations; logger: StructuredAgentSessionLogger },
  sessionId: string,
  journal: Pick<AgentSessionJournal, 'markQueueReopen'>,
  fence: number
): Promise<boolean> {
  const { logger } = host
  try {
    await journal.markQueueReopen(fence)
    return true
  } catch (error) {
    // Unmarked, so this host's next open of the chat marks it.
    openedBy(host.sessions).delete(sessionId)
    logger.warn('marking a reopened queue failed', {
      scope: 'queue-reopen-mark',
      sessionId,
      error
    })
    return false
  }
}

/** The open's mark, on this host's first open of the chat only (or the first since a close of it
 *  that had no conversation open): a restart or a crash ended it running elsewhere, while an idle
 *  eviction here changes nothing the person sees. */
export async function markStructuredQueueFirstOpen(
  host: { sessions: HostConversations; logger: StructuredAgentSessionLogger },
  sessionId: string,
  journal: Pick<AgentSessionJournal, 'markQueueReopen'>,
  fence: number
): Promise<void> {
  const opened = openedBy(host.sessions)
  if (
    !opened.has(sessionId) &&
    (await markStructuredQueueReopen(host, sessionId, journal, fence))
  ) {
    opened.add(sessionId)
  }
}

/** Resume: a journal row that ends every pause. Returns whether the queue was paused. */
export async function resumeStructuredQueue(
  journal: Pick<AgentSessionJournal, 'queuedMessages' | 'appendQueueResume'>,
  fence: number
): Promise<boolean> {
  if (structuredQueuePauses(journal).length === 0) {
    return false
  }
  await journal.appendQueueResume(fence)
  return true
}

/** A close of a chat this host has no conversation open for: its next open marks it. */
export function forgetStructuredQueueOpen(sessions: HostConversations, sessionId: string): void {
  openedBy(sessions).delete(sessionId)
}

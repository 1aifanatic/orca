// The one way a structured chat message reaches its host: composer, launch prompt and a message sent
// from outside the chat all call `sendStructuredAgentSessionMessage`, with or without the chat's view
// mounted. The host's journal and queue own every message they hold. This module keeps, in memory
// only, the one send per chat the host has not answered yet: for its "Sending…" bubble, and to put
// the message back in the composer when the host did not take it, or nobody can say. While it is
// out the chat takes no other send, which keeps the host's arrival order without a client line.
//
// Nothing here is saved, nothing outlives one deadline, and nothing is sent twice under a new id: a
// resend reuses the message's id, which the host never runs twice.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  agentSessionUnconfirmedSendParts,
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import type { AgentSessionWriteFailure } from '../../../../shared/agent-session-write-failure'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  attemptStructuredAgentSessionSend,
  forgetStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from './structured-agent-session-send-attempt'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import {
  takeStructuredAgentSessionSendSlot,
  type StructuredAgentSessionSendInput
} from './structured-agent-session-send-slot'
import {
  clearStructuredAgentSessionPendingSends,
  findStructuredAgentSessionPendingSend,
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  structuredAgentSessionSendsWatched,
  structuredAgentSessionsWithPendingSends,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

/** From the moment a message is sent: past it, the message goes back to the composer, saying it
 *  was not sent if it never went out, and that nobody could confirm it if it did. */
export const STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS = 30_000
const RESEND_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]

/** `returned`: back in the composer, not sent. `unconfirmed`: back in the composer, though the host
 *  may hold it. */
export type StructuredAgentSessionSendOutcome = 'recorded' | 'returned' | 'unconfirmed' | 'dropped'

type SendRuntime = {
  target: RuntimeClientTarget
  abort: AbortController
  deadline: ReturnType<typeof setTimeout>
  resend: ReturnType<typeof setTimeout> | null
  /** Attempts made, whether or not their request went out: paces the next one. */
  tries: number
  /** What the host's last thrown refusal said, for the words when nobody can confirm the send. */
  thrownRefusal: AgentSessionWriteFailure | null
  /** Bumped when the journal settles the send, so an answer still on its way changes nothing. */
  generation: number
  /** Its request is out and the answer not back yet. */
  awaiting: boolean
  /** A Stop came while it was out: its own answer still settles it, but it is never sent again. */
  stopped?: true
  resolve: (outcome: StructuredAgentSessionSendOutcome) => void
}

const runtimes = new Map<string, SendRuntime>()

/** Ends a send for good: the entry leaves (or stays as `recorded`) and its caller is answered. */
function finish(
  entry: StructuredAgentSessionPendingSend,
  outcome: StructuredAgentSessionSendOutcome,
  keep?: Partial<StructuredAgentSessionPendingSend>
): void {
  const runtime = runtimes.get(entry.clientMessageId)
  if (runtime) {
    clearTimeout(runtime.deadline)
    if (runtime.resend) {
      clearTimeout(runtime.resend)
    }
    runtime.generation += 1
    runtimes.delete(entry.clientMessageId)
    runtime.resolve(outcome)
  }
  updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, keep ?? null)
}

function handBack(
  entry: StructuredAgentSessionPendingSend,
  notice: readonly AgentSessionWriteNoticePart[] | null
): void {
  // A caller told `recorded` let go of its copy, so a later Stop's withdrawal returns it to the chat.
  const chatTakesText = !entry.callerKeepsText || entry.phase === 'recorded'
  if (chatTakesText) {
    handBackStructuredAgentSessionMessage(
      entry.sessionId,
      entry.clientMessageId,
      entry.body,
      entry.imageConnectionIds
    )
  }
  if (notice && chatTakesText) {
    publishStructuredAgentSessionSends(entry.sessionId, {
      notice: agentSessionWriteNoticeText([...notice])
    })
  }
  finish(entry, notice?.includes('sendOutcomeLost') ? 'unconfirmed' : 'returned')
}

/** Settled by the host's answer, from the send's own reply or the journal, whichever comes first. */
function settleRecorded(
  entry: StructuredAgentSessionPendingSend,
  submission: AgentJournalSubmission | null,
  from: 'reply' | 'journal'
): void {
  if (submission && dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined) {
    // A Stop took it back before the agent had it: the text goes back where it was typed.
    handBack(entry, null)
    return
  }
  // Kept while a Stop may still withdraw it, and, for an open chat, drawn until its row or card
  // arrives, which can trail the reply.
  const keep =
    submission?.dispatchState === 'pending' ||
    (from === 'reply' && structuredAgentSessionSendsWatched(entry.sessionId))
  finish(entry, 'recorded', keep ? { phase: 'recorded', issued: true } : undefined)
}

async function attempt(entry: StructuredAgentSessionPendingSend): Promise<void> {
  const runtime = runtimes.get(entry.clientMessageId)
  if (!runtime) {
    return
  }
  const generation = runtime.generation
  const outcome = await attemptStructuredAgentSessionSend({
    entry,
    target: runtime.target,
    beforeIssue: () => {
      if (runtime.generation !== generation || runtime.stopped) {
        return null
      }
      runtime.awaiting = true
      const latest = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
        issued: true
      })
      return { firstAttempt: !(latest?.issued ?? entry.issued) }
    },
    abandoned: () =>
      runtime.abort.signal.aborted ||
      runtime.generation !== generation ||
      runtimes.get(entry.clientMessageId) !== runtime
  })
  runtime.awaiting = false
  runtime.tries += 1
  const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  if (!outcome || !current) {
    return
  }
  const { evidence } = outcome
  runtime.thrownRefusal = outcome.thrownRefusal ?? runtime.thrownRefusal
  if (evidence.kind === 'recorded') {
    settleRecorded(current, outcome.submission, 'reply')
    return
  }
  if (evidence.kind === 'not-recorded') {
    handBack(current, agentSessionWriteNoticeParts(evidence.failure, 'composer-send'))
    return
  }
  if (evidence.kind === 'uncertain' || runtime.stopped) {
    handBack(current, agentSessionUnconfirmedSendParts(runtime.thrownRefusal))
    return
  }
  const delay = RESEND_DELAYS_MS[Math.min(runtime.tries, RESEND_DELAYS_MS.length) - 1]
  runtime.resend = setTimeout(() => {
    runtime.resend = null
    const latest = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
    if (latest?.phase === 'sending' && runtimes.get(entry.clientMessageId) === runtime) {
      void attempt(latest)
    }
  }, delay)
}

function onDeadline(sessionId: string, clientMessageId: string): void {
  const entry = findStructuredAgentSessionPendingSend(sessionId, clientMessageId)
  if (!entry || entry.phase === 'recorded') {
    return
  }
  runtimes.get(clientMessageId)?.abort.abort()
  // One that went out may still land: its row then shows it beside the text given back.
  handBack(
    entry,
    entry.issued
      ? agentSessionUnconfirmedSendParts(runtimes.get(clientMessageId)?.thrownRefusal)
      : ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')]
  )
}

export type StructuredAgentSessionSent = {
  clientMessageId: string
  outcome: Promise<StructuredAgentSessionSendOutcome>
}

/** Sends a message holding its chat's slot; its 30 s start now. */
function dispatch(
  entry: StructuredAgentSessionPendingSend,
  target: RuntimeClientTarget
): StructuredAgentSessionSent {
  const { clientMessageId, sessionId } = entry
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    runtimes.set(clientMessageId, {
      target,
      abort: new AbortController(),
      deadline: setTimeout(
        () => onDeadline(sessionId, clientMessageId),
        STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS
      ),
      resend: null,
      awaiting: false,
      tries: 0,
      thrownRefusal: null,
      generation: 0,
      resolve
    })
  })
  void attempt(entry)
  return { clientMessageId, outcome }
}

/**
 * Sends one message, or returns null while another send of its chat is out. Resolves once its fate
 * is known here: `recorded` (the host holds it), `returned` or `unconfirmed` (it went back to the
 * composer, with the reason on the chat's line), or `dropped` (its launch was cancelled or its
 * worktree purged).
 */
export function sendStructuredAgentSessionMessage(
  input: StructuredAgentSessionSendInput & { target: RuntimeClientTarget }
): StructuredAgentSessionSent | null {
  const entry = takeStructuredAgentSessionSendSlot(input)
  return entry ? dispatch(entry, input.target) : null
}

export type StructuredAgentSessionReservedSend = {
  /** Sends it once the chat exists; null when the reservation was released or dropped meanwhile. */
  send: (target: RuntimeClientTarget) => StructuredAgentSessionSent | null
  /** Gives the slot back unsent. */
  release: () => void
}

/**
 * A launch's prompt holds its chat's one send from the click: drawn as sending, so nothing typed
 * meanwhile overtakes it, and sent once the chat exists. Null while the chat already has a send out.
 */
export function reserveStructuredAgentSessionSend(
  input: StructuredAgentSessionSendInput
): StructuredAgentSessionReservedSend | null {
  const entry = takeStructuredAgentSessionSendSlot(input)
  if (!entry) {
    return null
  }
  const held = (): StructuredAgentSessionPendingSend | undefined => {
    const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
    return current && !runtimes.has(entry.clientMessageId) ? current : undefined
  }
  return {
    send: (target) => {
      const current = held()
      return current ? dispatch(current, target) : null
    },
    release: () => {
      if (held()) {
        updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, null)
      }
    }
  }
}

/**
 * Settles sends from the host's published state: a row under the message's id, a hand-off of a card
 * under it, or a card under it. Whichever of this and the send's own reply comes first decides.
 */
export function settleStructuredAgentSessionSendsFromJournal(
  sessionId: string,
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[]
): void {
  const entries = getStructuredAgentSessionPendingSends(sessionId)
  if (entries.length === 0) {
    return
  }
  const cards = new Set(queuedMessageIds)
  for (const submission of submissions) {
    if (submission.queuedMessageId !== undefined) {
      cards.add(submission.queuedMessageId)
    }
  }
  const rows = new Map(submissions.map((submission) => [submission.clientMessageId, submission]))
  for (const entry of entries) {
    const submission = rows.get(entry.clientMessageId)
    if (cards.has(entry.clientMessageId)) {
      finish(entry, 'recorded')
    } else if (submission) {
      if (entry.phase === 'recorded' && submission.dispatchState === 'pending') {
        continue
      }
      settleRecorded(entry, submission, 'journal')
    }
  }
}

/**
 * A Stop, or the chat's tab closing: nothing more goes out. A send whose request is out settles
 * from its answer; one between attempts goes back now, as unconfirmed; one still being readied
 * never went out, so it goes back silently.
 */
export function stopStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    if (!runtime) {
      continue
    }
    if (!entry.issued) {
      runtime.abort.abort()
      handBack(entry, null)
    } else if (runtime.awaiting) {
      runtime.stopped = true
    } else {
      handBack(entry, agentSessionUnconfirmedSendParts(runtime.thrownRefusal))
    }
  }
}

/** A cancelled launch or a purged worktree: its sends are dropped, and their callers told so. */
export function dropStructuredAgentSessionSends(sessionId: string): void {
  for (const entry of getStructuredAgentSessionPendingSends(sessionId)) {
    const runtime = runtimes.get(entry.clientMessageId)
    runtime?.abort.abort()
    if (runtime) {
      clearTimeout(runtime.deadline)
      if (runtime.resend) {
        clearTimeout(runtime.resend)
      }
      runtimes.delete(entry.clientMessageId)
      runtime.resolve('dropped')
    }
  }
  forgetStructuredAgentSessionFence(sessionId)
  clearStructuredAgentSessionPendingSends(sessionId)
}

export function resetStructuredAgentSessionSendsForTests(): void {
  for (const sessionId of structuredAgentSessionsWithPendingSends()) {
    dropStructuredAgentSessionSends(sessionId)
  }
  resetStructuredAgentSessionFencesForTests()
}

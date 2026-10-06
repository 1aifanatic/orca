// The one way a structured chat message reaches its host: composer, launch prompt and a message sent
// from outside the chat all call `sendStructuredAgentSessionMessage`, with or without the chat's view
// mounted. The host's journal and queue own every message they hold. This module keeps, in memory
// only, the sends the host has not answered yet: for their "Sending…" bubble, to keep them in order,
// and to put a message back in the composer when the host did not take it, or nobody can say.
//
// Nothing here is saved, nothing blocks a later send past one deadline, and nothing is sent twice
// under a new id: a resend reuses the message's id, which the host never runs twice.

import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import {
  agentSessionWriteNoticeParts,
  agentSessionWriteNotDoneParts
} from '../../../../shared/agent-session-refusal-notice'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import {
  structuredAgentSessionSendBody,
  type StructuredAgentSessionAttachment
} from '../../../../shared/structured-agent-session-send-mutation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  attemptStructuredAgentSessionSend,
  forgetStructuredAgentSessionFence,
  resetStructuredAgentSessionFencesForTests
} from './structured-agent-session-send-attempt'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import {
  clearStructuredAgentSessionPendingSends,
  findStructuredAgentSessionPendingSend,
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  structuredAgentSessionsWithPendingSends,
  updateStructuredAgentSessionPendingSend,
  type StructuredAgentSessionPendingSend
} from './structured-agent-session-pending-sends'

/** From the moment a message is sent: past it, the message goes back to the composer, saying it
 *  was not sent if it never went out, and that nobody could confirm it if it did. */
export const STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS = 30_000
const RESEND_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]

export type StructuredAgentSessionSendOutcome = 'recorded' | 'returned' | 'dropped'

type SendRuntime = {
  target: RuntimeClientTarget
  abort: AbortController
  deadline: ReturnType<typeof setTimeout>
  resend: ReturnType<typeof setTimeout> | null
  attempts: number
  /** Bumped when the journal settles the send, so an answer still on its way changes nothing. */
  generation: number
  /** A Stop came after it went out: its own answer still settles it, but it is never sent again. */
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
  pump(entry.sessionId)
}

function handBack(
  entry: StructuredAgentSessionPendingSend,
  notice: readonly AgentSessionWriteNoticePart[] | null
): void {
  if (!entry.callerKeepsText) {
    handBackStructuredAgentSessionMessage(
      entry.sessionId,
      entry.clientMessageId,
      entry.body,
      entry.imageConnectionIds
    )
  }
  if (notice && !entry.callerKeepsText) {
    publishStructuredAgentSessionSends(entry.sessionId, {
      notice: agentSessionWriteNoticeText([...notice])
    })
  }
  finish(entry, 'returned')
}

/** Settled by the host's answer, from the send's own reply or the journal, whichever comes first. */
function settleRecorded(
  entry: StructuredAgentSessionPendingSend,
  submission: AgentJournalSubmission | null
): void {
  if (submission && dispatchWasWithdrawn(submission) && submission.queuedMessageId === undefined) {
    // A Stop took it back before the agent had it: the text goes back where it was typed.
    handBack(entry, null)
    return
  }
  finish(
    entry,
    'recorded',
    submission?.dispatchState === 'pending' ? { phase: 'recorded', issued: true } : undefined
  )
}

function pump(sessionId: string): void {
  const entries = getStructuredAgentSessionPendingSends(sessionId)
  // One send out at a time keeps the host's arrival order; a recorded one holds nothing.
  if (entries.some((entry) => entry.phase === 'sending')) {
    return
  }
  const next = entries.find((entry) => entry.phase === 'waiting')
  if (next) {
    void attempt(next)
  }
}

async function attempt(entry: StructuredAgentSessionPendingSend): Promise<void> {
  const runtime = runtimes.get(entry.clientMessageId)
  if (!runtime) {
    return
  }
  const generation = runtime.generation
  updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
    phase: 'sending'
  })
  const outcome = await attemptStructuredAgentSessionSend({
    entry,
    target: runtime.target,
    beforeIssue: () => {
      if (runtime.generation !== generation) {
        return null
      }
      const latest = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
      updateStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId, {
        issued: true
      })
      runtime.attempts += 1
      return { firstAttempt: !(latest?.issued ?? entry.issued) }
    },
    abandoned: () =>
      runtime.abort.signal.aborted ||
      runtime.generation !== generation ||
      runtimes.get(entry.clientMessageId) !== runtime
  })
  const current = findStructuredAgentSessionPendingSend(entry.sessionId, entry.clientMessageId)
  if (!outcome || !current) {
    return
  }
  const { evidence } = outcome
  if (evidence.kind === 'recorded') {
    settleRecorded(current, outcome.submission)
    return
  }
  if (evidence.kind === 'not-recorded') {
    handBack(current, agentSessionWriteNoticeParts(evidence.failure, 'composer-send'))
    return
  }
  if (evidence.kind === 'uncertain' || runtime.stopped) {
    handBack(current, ['sendOutcomeLost'])
    return
  }
  const delay = RESEND_DELAYS_MS[Math.min(runtime.attempts - 1, RESEND_DELAYS_MS.length - 1)]
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
      ? ['sendOutcomeLost']
      : ['unreachable', ...agentSessionWriteNotDoneParts('composer-send')]
  )
}

/**
 * Sends one message. Resolves once its fate is known here: `recorded` (the host holds it),
 * `returned` (it went back to the composer, with the reason on the chat's line), or `dropped` (its
 * chat closed first).
 */
export function sendStructuredAgentSessionMessage(input: {
  sessionId: string
  target: RuntimeClientTarget
  text: string
  attachments?: readonly StructuredAgentSessionAttachment[]
  /** Asks the host to hold it as a card while the agent works; decided once, for every resend. */
  delivery?: 'queue-if-active'
  /** The caller keeps the text if it comes back, instead of the chat's composer. */
  callerKeepsText?: true
  now?: number
}): { clientMessageId: string; outcome: Promise<StructuredAgentSessionSendOutcome> } {
  const attachments = input.attachments ?? []
  const clientMessageId = createStructuredAgentSessionOperationId(createBrowserUuid)
  const entry: StructuredAgentSessionPendingSend = {
    clientMessageId,
    sessionId: input.sessionId,
    body: structuredAgentSessionSendBody(input.text, attachments),
    previewUris: attachments.map((attachment) => attachment.previewUri),
    queuedAt: input.now ?? Date.now(),
    ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.callerKeepsText ? { callerKeepsText: true as const } : {}),
    ...(attachments.some((attachment) => attachment.connectionId)
      ? { imageConnectionIds: attachments.map((attachment) => attachment.connectionId ?? null) }
      : {}),
    phase: 'waiting',
    issued: false
  }
  const outcome = new Promise<StructuredAgentSessionSendOutcome>((resolve) => {
    runtimes.set(clientMessageId, {
      target: input.target,
      abort: new AbortController(),
      deadline: setTimeout(
        () => onDeadline(input.sessionId, clientMessageId),
        STRUCTURED_AGENT_SESSION_SEND_BUDGET_MS
      ),
      resend: null,
      attempts: 0,
      generation: 0,
      resolve
    })
  })
  publishStructuredAgentSessionSends(input.sessionId, {
    entries: [...getStructuredAgentSessionPendingSends(input.sessionId), entry],
    notice: null
  })
  pump(input.sessionId)
  return { clientMessageId, outcome }
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
      settleRecorded(entry, submission)
    }
  }
}

/** A Stop: what has not gone out yet goes back to the composer instead of starting a turn, and
 *  what has is never sent again under its id; one waiting to be resent goes back now. */
export function withdrawUnsentStructuredAgentSessionSends(sessionId: string): boolean {
  const entries = getStructuredAgentSessionPendingSends(sessionId)
  for (const entry of entries) {
    const runtime = runtimes.get(entry.clientMessageId)
    if (!entry.issued) {
      runtime?.abort.abort()
      handBack(entry, null)
    } else if (runtime && entry.phase === 'sending') {
      runtime.stopped = true
      if (runtime.resend) {
        handBack(entry, ['sendOutcomeLost'])
      }
    }
  }
  return entries.some((entry) => !entry.issued)
}

/** The chat closed: its sends are dropped with it, and their callers told so. */
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

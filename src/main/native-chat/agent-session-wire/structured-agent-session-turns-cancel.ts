import { agentChildWorkStopTargets } from '../../../shared/agent-child-work-stop-targets'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentJournalStatusItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { latestJournalDispatchObservation } from '../agent-session-journal/journal-dispatch-observation'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import {
  isStructuredAgentSessionCommandTurnId,
  structuredAgentSessionCommandWasStopped,
  structuredAgentSessionStopNoteIdentity
} from './structured-agent-session-command-turn'
import {
  answerCancelOfSettledPrompt,
  validatePendingPrompt
} from './structured-agent-session-prompt-state'
import {
  STOP_NOTE_CANCELLATION_REQUESTED,
  structuredAgentSessionNamedTurnScope,
  structuredAgentSessionStopNamesTurnNotLive,
  structuredAgentSessionStoppedTurnId
} from './structured-agent-session-turn-stop-notes'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import { runningTurnLifecycleRevisions } from './structured-agent-session-stale-turn-verdict'
import type { StructuredAgentSessionStopWindDown } from './structured-agent-session-stop-wind-down'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

/** Claude's echo accepts a send one sink write before its turn row lands, so read after the drain.
 *  A failed drain reads working: bookkeeping never talks a Stop out of stopping. */
export async function isMainAgentWorkingOnceFlushed(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'flushStreamedEvents'>
): Promise<boolean> {
  try {
    await ctx.flushStreamedEvents()
  } catch {
    return true
  }
  return isStructuredAgentSessionMainAgentWorking(
    ctx.journal.activeTurnId(),
    ctx.journal.submissions(),
    ctx.fence
  )
}

/**
 * After an interrupt that failed: whether the session still runs what the Stop was sent for. One at
 * rest, or running a different turn, is not the Stop's to end. A child that exited reads at rest:
 * its exit ends its turn, and the host's own exit handling waits behind this step.
 */
async function stillRunsStoppedTurn(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'flushStreamedEvents'>,
  stoppedTurnId: string | null
): Promise<boolean> {
  if (!(await isMainAgentWorkingOnceFlushed(ctx))) {
    return false
  }
  // Working with no turn open after the Stop's turn is a later send whose turn has not opened.
  return stoppedTurnId === null || ctx.journal.activeTurnId() === stoppedTurnId
}

/** The row for a Stop the provider declined, in its words when it gave any. One that could not
 *  reach a turn still able to open says the Stop is unconfirmed, never that nothing ran. */
function stopRefusedNote(
  ctx: Pick<AgentSessionTurnContext, 'failureTextContext'>,
  refusal: AgentSessionCancelOutcome['refusal']
): AgentJournalStatusItem {
  const detail = refusal?.detail
  const fact = refusal?.turnMayOpen
    ? agentSessionFailureFact('cancelUnconfirmed')
    : agentSessionFailureFact('stopRefused', detail ? { detail } : {})
  return {
    kind: 'status',
    ...agentSessionFailureWords(fact, { ...ctx.failureTextContext, surface: 'row' })
  }
}

/** A turn the Stop's interrupt took that still reads running once the stream drains: the Stop ends
 *  it, once, while it still binds it. Bookkeeping: a failure is reported, never the Stop's. */
async function endStoppedTurnAtSettle(ctx: AgentSessionTurnContext, turnId: string): Promise<void> {
  try {
    await ctx.flushStreamedEvents()
    const running = ctx.journal
      .snapshot()
      .items.filter((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
    const mutations = runningTurnLifecycleRevisions(running, {
      state: 'interrupted',
      completedAt: ctx.now()
    })
    if (mutations.length > 0) {
      await ctx.journal.appendLifecycleBatch({
        settlementId: `stop-settled:${turnId}`,
        mutations,
        fence: ctx.fence
      })
    }
  } catch (error) {
    ctx.logger.warn("ending a stopped turn at its Stop's settle failed", {
      scope: 'stop-settle',
      sessionId: ctx.sessionId,
      error
    })
  }
}

/** What the Stop's settle binds: the turn it stopped, and whether its wind-down closes it. */
type StopSettleBinding = { turnId?: string; closedByWindDown?: true }

export async function performCancel(
  ctx: AgentSessionTurnContext,
  input: PerformCancelInput
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  if (input.prompt) {
    const validated = validatePendingPrompt(ctx, input.prompt)
    if (!validated.ok) {
      return answerCancelOfSettledPrompt(ctx, { ...input, prompt: input.prompt }, validated)
    }
  }
  // A person's Stop that named no turn binds what ends while it settles (`beginJournalStopSettle`).
  const settle = input.opensSettle ? ctx.journal.stopMarks.beginSettle() : null
  const binding: StopSettleBinding = {}
  // A wind-down that failed with work running on binds that work's turn, as a failed Stop does.
  const close = (failedOn?: string): void =>
    ctx.journal.stopMarks.settled(settle, binding.turnId ?? failedOn)
  try {
    return await cancelAndNote(ctx, input, binding, close)
  } finally {
    if (!binding.closedByWindDown) {
      close()
    }
  }
}

type PerformCancelInput = {
  clientOperationId: string
  /** Absent: whatever the conversation has in flight; present: only while that turn is current. */
  turnId?: string
  scope?: 'background-tasks'
  taskId?: string
  prompt?: { itemId: string; expectedRevision: number }
  /** Ends the provider child, for a running command the provider did not take the Stop on, or a
   *  turn whose interrupt failed. */
  stopChild?: () => Promise<void>
  /** A child end after a failed interrupt that threw. */
  onStopChildError?: (error: unknown) => void
  /** After that throw: whether the host let go of the child, its exit proven before a later
   *  cleanup step failed. */
  childReleased?: () => boolean
  /** Hands the child's end to the Stop's next serialized step, for a provider whose Stop ends
   *  its session. */
  endSession?: (windDown: StructuredAgentSessionStopWindDown) => void
  /** The host already withdrew queued messages for this Stop. */
  withdrewQueued?: boolean
  /** The session's child records: a background Stop reaches the tasks they offer a stop. */
  childWork?: () => readonly AgentChildWorkView[] | undefined
  /** The latest Stop event is this press's own, or the in-force one it repeats: its settle binds. */
  opensSettle?: true
}

async function cancelAndNote(
  ctx: AgentSessionTurnContext,
  input: PerformCancelInput,
  binding: StopSettleBinding,
  closeSettle: (failedOn?: string) => void
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  let cancelled = false
  let note: AgentJournalStatusItem | null = {
    kind: 'status',
    text: STOP_NOTE_CANCELLATION_REQUESTED
  }
  // The turn the Stop names, read before the cancel settles it: the note reports on that turn.
  const turnScope =
    (input.turnId !== undefined && !input.scope
      ? structuredAgentSessionNamedTurnScope(ctx.journal, input.turnId)
      : null) ?? ctx.journal.liveTurnScope()
  // Only the provider's end or the child's ends a command. A command the provider has not opened a
  // turn for, would not interrupt, or was already asked to stop, ends with its child; that child's
  // dead-generation settlement writes the command's verdict.
  const liveTurnId = ctx.journal.activeTurnId()
  // Read with the live turn, before the cancel settles it: the note is keyed by this turn.
  const stoppedTurnId = structuredAgentSessionStoppedTurnId(ctx.journal, input.turnId)
  const namesTurnNotLive = structuredAgentSessionStopNamesTurnNotLive(input.turnId, liveTurnId)
  const runningCommand =
    input.stopChild !== undefined &&
    liveTurnId !== null &&
    isStructuredAgentSessionCommandTurnId(liveTurnId) &&
    !namesTurnNotLive
  const stoppedBefore =
    runningCommand && structuredAgentSessionCommandWasStopped(ctx.journal, liveTurnId)
  // Read while the child is live: a provider whose Stop is a session boundary loses it next.
  const endsSession =
    input.endSession !== undefined && ctx.adapter.stopEndsSession?.(ctx.sessionId) === true
  // Keyed by the turn it stopped, so another Stop of that turn rewrites this row, never adds one.
  const noteIdentity = structuredAgentSessionStopNoteIdentity(
    stoppedTurnId ?? input.clientOperationId
  )
  const stoppedAt = Date.now()
  // The provider's own answer; unset when its cancel threw, leaving the effect unknown.
  let taken: boolean | undefined
  // The provider could not interrupt the turn, or its cancel threw: the turn may run on.
  let interruptFailed = false
  let refusal: AgentSessionCancelOutcome['refusal']
  // The turn the provider says this Stop's interrupt took.
  let stoppedTurn: string | undefined
  try {
    const dispatchStatus = latestJournalDispatchObservation(ctx.journal, ctx.fence)
    const outcome: AgentSessionCancelOutcome = stoppedBefore
      ? { cancelled: false }
      : input.scope
        ? {
            cancelled:
              (
                await ctx.adapter.stopBackgroundTasks?.({
                  sessionId: ctx.sessionId,
                  fence: ctx.fence,
                  taskIds: agentChildWorkStopTargets(input.childWork?.(), input.taskId)
                })
              )?.cancelled === true
          }
        : await ctx.adapter.cancelTurn({
            sessionId: ctx.sessionId,
            ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
            fence: ctx.fence,
            // The journal is what the client read to name a turn, so it is what judges the request.
            resolveLiveTurnId: () => ctx.journal.activeTurnId(),
            ...(dispatchStatus ? { dispatchStatus } : {}),
            ...(input.prompt ? { prompt: { itemId: input.prompt.itemId } } : {})
          })
    taken = outcome.cancelled
    cancelled = outcome.cancelled
    refusal = outcome.refusal
    stoppedTurn = outcome.turnId
    interruptFailed = refusal !== undefined && refusal.turnNotRunning !== true
    if (!cancelled && input.withdrewQueued && !(await isMainAgentWorkingOnceFlushed(ctx))) {
      // A Stop that withdrew what was queued and left nothing working ended what it was sent for,
      // named or not. The journal judges it: providers differ on refusing a turn that has ended.
      cancelled = true
      note = null
    } else if (!cancelled && input.prompt) {
      note = null
    } else if (!cancelled && input.turnId === undefined) {
      // Sent only while the chat reads working, so a Stop that ended nothing must say why.
      note = stopRefusedNote(ctx, refusal)
    }
  } catch (error) {
    if (input.prompt) {
      throw error
    }
    interruptFailed = true
    // The adapter's error is Orca's; the row says only that the stop is unconfirmed.
    note = {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelUnconfirmed'), { surface: 'row' })
    }
  }
  // A Stop naming a turn that has since ended keeps the session only when the provider declined
  // it: an interrupt, answered or not, can stop a follow-up whose turn has not opened.
  if (endsSession && (!namesTurnNotLive || taken !== false)) {
    // An interrupt the provider took is worth waiting on, turn row or not: a Stop before the echo
    // has none, and the echo still opens the turn the Stop interrupted.
    binding.closedByWindDown = true
    input.endSession?.({
      waitsForProvider: taken === true,
      stoppedAt,
      stopNote: noteIdentity,
      settled: closeSettle
    })
    cancelled = true
    // The child's end confirms the Stop, so a refused or unconfirmed interrupt says nothing more.
    if (note !== null) {
      note = { kind: 'status', text: 'Cancellation requested.' }
    }
  } else if (runningCommand && !cancelled) {
    await input.stopChild?.()
    cancelled = true
    note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
  } else if (
    !cancelled &&
    interruptFailed &&
    input.stopChild &&
    // An unnamed Stop meant the turn the journal showed when it was sent.
    (await stillRunsStoppedTurn(ctx, stoppedTurnId))
  ) {
    // The interrupt failed and the turn runs on: only the child's end stops it.
    let ended: boolean
    try {
      await input.stopChild()
      ended = true
    } catch (error) {
      input.onStopChildError?.(error)
      // Unless the exit was proven, the child may still run the turn and the failed row stays true.
      ended = input.childReleased?.() === true
    }
    if (ended) {
      cancelled = true
      note = { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED }
    } else if (taken !== undefined) {
      // The turn was just read running, so a named Stop says it was refused rather than nothing.
      note = stopRefusedNote(ctx, refusal)
    }
  } else if (!cancelled && taken === false && input.turnId !== undefined) {
    // Nothing was left of the turn it named and nothing else ended: a Stop that ends nothing writes no row.
    note = null
  }
  if (cancelled && input.prompt) {
    await ctx.flushStreamedEvents()
  }
  if (cancelled) {
    binding.turnId = stoppedTurn ?? stoppedTurnId ?? undefined
  } else if (interruptFailed) {
    // A Stop that failed still holds the turn it could not stop, until that turn ends.
    binding.turnId = ctx.journal.activeTurnId() ?? undefined
  }
  if (taken === true && stoppedTurn !== undefined && !binding.closedByWindDown && !input.scope) {
    await endStoppedTurnAtSettle(ctx, stoppedTurn)
  }
  const value = { ...(input.turnId !== undefined ? { turnId: input.turnId } : {}), cancelled }
  if (input.scope || note === null) {
    return { ok: true, value }
  }
  await ctx.journal.appendItem(noteIdentity, note, { fence: ctx.fence, turnScope })
  return { ok: true, value }
}

/**
 * The one way Orca sends a message into an agent on another agent's behalf.
 *
 * Built only from the paths a user's own message already takes: a structured chat gets
 * `host.send` (the composer's `sendStructuredAgentSessionTurn`, queue decision included) and the
 * host's own settlement waiter; a terminal gets `sendTerminalAgentPrompt`. Callers keep their own
 * reading of the outcome; what they share is the send and the wait.
 */

import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentSessionSendSubmission } from '../../../shared/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire-refusals'
import { ORCHESTRATION_READINESS_TIMEOUT_MS } from '../../../shared/orchestration-timing-budgets'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { dispatchPreambleSendOptions, type DispatchPreambleSendOptions } from './preamble'

/**
 * `now` hands the message over at once, joining a running turn as a steer. `queue` asks a busy chat
 * to hold it as a draft its queue sends when the turn ends, the composer's default. A terminal has
 * one write either way: whether a mid-turn prompt waits is the agent TUI's own behaviour.
 */
export type AgentTurnDelivery = 'queue' | 'now'

/** What a structured send reads of the host. */
export type StructuredAgentTurnHost = Pick<
  StructuredAgentSessionHost,
  'send' | 'waitForSendSettlement'
>

export type StructuredSessionTurnTarget = {
  kind: 'structured-session'
  host: StructuredAgentTurnHost
  sessionId: string
  /** Scopes the host's operation ledger, so one sender's sends cannot exhaust another's budget. */
  callerKey: string
}

/** Method syntax on purpose: the runtime's own signature takes the wider write options. */
type TerminalAgentTurnRuntime<TReceipt> = {
  sendTerminalAgentPrompt(
    handle: string,
    prompt: string,
    options: DispatchPreambleSendOptions
  ): Promise<TReceipt>
}

export type TerminalTurnTarget<TReceipt> = {
  kind: 'terminal'
  runtime: TerminalAgentTurnRuntime<TReceipt>
  handle: string
}

export type StructuredSessionTurn = {
  body: AgentJournalMessageItem
  delivery: AgentTurnDelivery
  /** Reused on a retry, so the host replays its recorded answer instead of sending twice. */
  operationId: string
  expectedRuntimeFence: number
  payloadFingerprint: string
}

/** Typed as every orchestration prompt is: `dispatchPreambleSendOptions`, keyed on `operationId`. */
export type TerminalTurn = {
  body: string
  delivery: AgentTurnDelivery
  /** The request id the write's receipt is correlated on. */
  operationId: string
}

/**
 * `sent` carries the submission as it settled, or as first answered when the wait ran out; it is
 * undefined when the host answered with no submission at all, which proves neither outcome.
 */
export type StructuredSessionTurnOutcome =
  | { kind: 'refused'; refusal: AgentSessionWireRefusal }
  | { kind: 'queued'; clientMessageId: string }
  | { kind: 'sent'; clientMessageId: string; submission: AgentJournalSubmission | undefined }

export function sendAgentTurn(
  target: StructuredSessionTurnTarget,
  turn: StructuredSessionTurn
): Promise<StructuredSessionTurnOutcome>
export function sendAgentTurn<TReceipt>(
  target: TerminalTurnTarget<TReceipt>,
  turn: TerminalTurn
): Promise<TReceipt>
export function sendAgentTurn<TReceipt>(
  target: StructuredSessionTurnTarget | TerminalTurnTarget<TReceipt>,
  turn: StructuredSessionTurn | TerminalTurn
): Promise<StructuredSessionTurnOutcome | TReceipt> {
  if (target.kind === 'terminal') {
    if ('payloadFingerprint' in turn) {
      return Promise.reject(new TypeError('A terminal takes its turn as a typed prompt.'))
    }
    return target.runtime.sendTerminalAgentPrompt(
      target.handle,
      turn.body,
      dispatchPreambleSendOptions(turn.operationId)
    )
  }
  if (!('payloadFingerprint' in turn)) {
    return Promise.reject(new TypeError('A structured session takes its turn as a message.'))
  }
  return sendStructuredSessionTurn(target, turn)
}

async function sendStructuredSessionTurn(
  target: StructuredSessionTurnTarget,
  turn: StructuredSessionTurn
): Promise<StructuredSessionTurnOutcome> {
  const result = await target.host.send(
    { callerKey: target.callerKey },
    {
      envelope: {
        sessionId: target.sessionId,
        clientOperationId: turn.operationId,
        expectedRuntimeFence: turn.expectedRuntimeFence,
        payloadFingerprint: turn.payloadFingerprint
      },
      body: turn.body,
      ...(turn.delivery === 'queue' ? { delivery: 'queue-if-active' as const } : {})
    }
  )
  if (!result.ok) {
    return { kind: 'refused', refusal: result.refusal }
  }
  const { clientMessageId } = result.value
  if ('queued' in result.value) {
    return { kind: 'queued', clientMessageId }
  }
  // Accepted is not delivered: the agent may still be starting, so wait the start out. A wait
  // that fails or runs out leaves the first answer standing.
  const answered = agentSessionSendSubmission(result.value)
  if (answered?.dispatchState !== 'pending') {
    return { kind: 'sent', clientMessageId, submission: answered }
  }
  const settled = await target.host
    .waitForSendSettlement(target.sessionId, clientMessageId, {
      budgetMs: ORCHESTRATION_READINESS_TIMEOUT_MS
    })
    .catch(() => undefined)
  return {
    kind: 'sent',
    clientMessageId,
    submission: agentSessionSendSubmission(settled?.value) ?? answered
  }
}

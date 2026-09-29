/**
 * Delivery decisions for an orchestration mail pointer aimed at a host-owned
 * structured ("native") agent session.
 *
 * A structured session has no PTY the pointer can be typed into, so the nudge
 * travels as a session turn instead of as bytes. Everything here is pure: the
 * caller supplies the session's gate facts, and gets back a decision it can
 * act on. Orchestration's database stays the source of truth —
 * no decision here ever consumes mail, it only says whether the nudge may be
 * attempted now.
 */

import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  isSubmissionRejectionKind,
  type SubmissionRejectionKind
} from '../../../shared/agent-session-failure'
import { DISPATCH_DOUBT_PROVIDER_EXITED } from '../../native-chat/agent-session-journal/journal-dispatch-doubt-reasons'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'

/** Every reason retains the pointer; none of them consume mail. */
export type StructuredPointerRetainReason =
  | 'session-not-attached'
  | 'turn-unsettled'
  | 'awaiting-human'
  | 'dispatch-rejected'
  | 'dispatch-unknown'
  | 'awaiting-next-turn'

export type StructuredPointerDecision =
  | { deliver: true }
  | { deliver: false; retain: StructuredPointerRetainReason }

/** The dispatch states both provider adapters converge on. */
export type StructuredDispatchState = 'accepted' | 'pending' | 'rejected' | 'unknown'

/**
 * What the delivery gate needs to know about a session, read once per attempt.
 *
 * Deliberately two booleans rather than the journal: the caller reads the FULL reduced timeline
 * (see `readGateFacts`), so nothing downstream can be tempted to re-derive them from a page.
 */
export type StructuredSessionGateFacts = {
  turnRunning: boolean
  /** A pending approval or question only a human can clear. */
  awaitingHuman: boolean
  /** The latest send never ran, and pointing again would only start the agent to fail again. */
  latestSendHoldsMail?: boolean
}

/**
 * Whether a send rejected for this reason holds the session's mail until a later send runs: the
 * provider exited or could not start, or its start needs the person to act first. A retry nobody
 * asked for would start it again to fail again, and the person's next message retries the start.
 * A new kind does not compile until it is placed here.
 */
const REJECTION_HOLDS_MAIL = {
  providerExited: true,
  providerStartFailed: true,
  startFailed: true,
  restartFailed: true,
  // A start that went quiet so long the host stopped it: starting again would hang again.
  hostStopped: true,
  notSignedIn: true,
  historyTooLarge: true,
  managedAccountEnvOverride: true,
  managedAccountUnsupported: true,
  // Ends on its own: the next edge's retry starts the agent once the switch settles.
  accountSwitchInProgress: false,
  cancelled: false,
  hostRestarted: false,
  chatClosed: false,
  notDelivered: false,
  providerRejected: false,
  attachmentInvalid: false,
  attachmentUnreadable: false,
  emptyMessage: false,
  queueFull: false,
  writeFailed: false,
  hostFault: false
} satisfies Record<SubmissionRejectionKind, boolean>

/**
 * Whether the session's latest send never ran and its mail must wait for a later send that does:
 * its provider died before echoing it, or a start it needed failed in a way `REJECTION_HOLDS_MAIL`
 * holds. Pointing again would start that agent again, which is how a provider that dies on every
 * turn was respawned in a loop; the next turn that does run clears it.
 */
export function latestSendHoldsMail(
  submissions: readonly Pick<AgentJournalSubmission, 'dispatchState' | 'reason' | 'rejection'>[]
): boolean {
  const latest = submissions.at(-1)
  if (latest?.dispatchState === 'unknown') {
    return latest.reason === DISPATCH_DOUBT_PROVIDER_EXITED
  }
  const kind = latest?.dispatchState === 'rejected' ? latest.rejection?.kind : undefined
  return isSubmissionRejectionKind(kind) && REJECTION_HOLDS_MAIL[kind]
}

/**
 * Projects the gate facts off a session's live items.
 *
 * Reuses the projection the chat view already reads, so the delivery gate and the visible
 * "working" state can never disagree. Both must be answered from the fully reduced timeline: a
 * settled turn is TOMBSTONED rather than rewritten to `completed`, so on a bounded tail page an
 * idle session and a running turn whose lifecycle item was pushed off the end look identical —
 * and idle-with-history is the normal steady state of a working agent.
 */
export function structuredSessionGateFacts(
  items: readonly AgentJournalRenderItem[]
): StructuredSessionGateFacts {
  return {
    turnRunning: activeStructuredAgentSessionTurnId(items) !== null,
    awaitingHuman: projectStructuredAgentSessionStatus(items) === 'attention'
  }
}

/**
 * Decide whether the nudge may be sent right now.
 *
 * Mid-turn delivery is refused for both providers rather than delegated to
 * them. Neither refuses the frame: Codex COALESCES a mid-turn `turn/start` into
 * the running turn -- measured on codex-cli 0.147.0, 0.150.1 and 0.153.4, none
 * of which refuse it and none of which fire a second `turn/started` -- and
 * Claude folds it into the running turn (or runs it as the next turn when the
 * turn ends first). Both therefore
 * fold the nudge into work already in flight, where it reads as part of the
 * running turn rather than a new instruction. Waiting for the turn to settle is
 * the one contract that holds for both, and it preserves orchestration's
 * existing idle-edge-only delivery policy.
 */
export function decideStructuredSessionPointerDelivery(input: {
  session: StructuredSessionGateFacts | null
}): StructuredPointerDecision {
  if (!input.session) {
    return { deliver: false, retain: 'session-not-attached' }
  }
  // Checked before the turn gate: a pending prompt has no running turn, so the turn test alone
  // reads it as idle, and sending there queues a nudge behind something only a human can clear.
  if (input.session.awaitingHuman) {
    return { deliver: false, retain: 'awaiting-human' }
  }
  if (input.session.turnRunning) {
    return { deliver: false, retain: 'turn-unsettled' }
  }
  if (input.session.latestSendHoldsMail) {
    return { deliver: false, retain: 'awaiting-next-turn' }
  }
  return { deliver: true }
}

/**
 * Whether the pointer has been POINTED: the provider took the turn. `accepted` is echoed and
 * `pending` is admitted and awaiting its echo; both mean the turn exists, so marking the rows
 * delivered stops them being pointed again. Neither consumes mail: `read` is only set by `check`.
 *
 * `unknown` covers a dead provider child and a failed call alike — the adapters cannot tell them
 * apart — so it must retain. Treating it as delivered would drop mail whenever a child died mid-send.
 */
export function structuredDispatchDelivered(
  state: StructuredDispatchState
): state is 'accepted' | 'pending' {
  return state === 'accepted' || state === 'pending'
}

export function retainReasonForDispatch(
  state: Exclude<StructuredDispatchState, 'accepted' | 'pending'>
): StructuredPointerRetainReason {
  return state === 'rejected' ? 'dispatch-rejected' : 'dispatch-unknown'
}

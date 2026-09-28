// Host-held drafts as this pane acts on them: the card list, Send-now (Steer),
// Delete, Edit (withdraw-to-composer), and the write-ahead withdrawal restore
// Stop and /clear share. Everything durable lives on the host; this hook keeps
// only presentation and the restore bookkeeping the write-ahead contract needs.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../../shared/agent-session-conversation-command'
import type {
  AgentSessionCancelResult,
  AgentSessionQueuedMessage,
  AgentSessionQueuedMessageDeleteResult,
  AgentSessionSendResult,
  AgentSessionWithdrawnQueuedMessage
} from '../../../../shared/agent-session-wire'
import {
  newestSteerableQueuedMessageCard,
  projectQueuedMessageCards,
  type QueuedMessageCard
} from './structured-agent-session-queued-cards'
import {
  abandonQueuedWithdrawal,
  beginQueuedWithdrawal,
  completeQueuedWithdrawal,
  pendingQueuedWithdrawals,
  writeQueuedWithdrawal
} from './structured-agent-session-queued-restore'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionWrite,
  StructuredAgentSessionWriteOutcome
} from './use-structured-agent-session-mutate'

export type StructuredAgentSessionQueuedMessagesController = {
  cards: QueuedMessageCard[]
  /** Send-now into the running turn; the transcript shows it at delivery position. */
  steer: (messageId: string) => Promise<void>
  remove: (messageId: string) => Promise<void>
  /** Withdraw the draft and put its text back in the composer for editing. */
  edit: (messageId: string) => Promise<void>
  /** Cmd/Ctrl+Enter: Send-now the newest card. False when there is none to steer. */
  steerNewest: () => boolean
  /** The capable-host Stop: interrupt + withdraw drafts, restoring their text.
   *  `alreadyRestored` names ids whose text the sender's own outbox withdrawal
   *  just put back, so `withdrawnQueued` never duplicates it. */
  stopWithdrawing: (alreadyRestored?: readonly string[]) => Promise<AgentSessionCancelResult | null>
  /** The conversation-command write. A capable /clear also withdraws drafts, and their
   *  text lands in the replacement session's pane; anything else is today's request. */
  writeConversationCommand: (
    command: AgentSessionConversationCommand
  ) => Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>>
}

type PressedWork = { turnId: string | null; submissions: readonly AgentJournalSubmission[] }

/** A Stop names no turn, so a replay the host never saw runs against whatever is in flight when
 *  it lands: only while that is still what the press saw — no other turn, no newer send. Else the
 *  Stop is reported unconfirmed rather than interrupting work begun after it. */
function isStillPressedWork(pressed: PressedWork, now: PressedWork): boolean {
  if (pressed.turnId !== null && now.turnId !== null && now.turnId !== pressed.turnId) {
    return false
  }
  const known = new Set(pressed.submissions.map((submission) => submission.clientMessageId))
  return now.submissions.every((submission) => known.has(submission.clientMessageId))
}

function alreadySentNotice(): void {
  toast.error(
    translate('components.native-chat.queuedMessages.alreadySent', 'This message was already sent.')
  )
}

export function useStructuredAgentSessionQueuedMessages(args: {
  sessionId: string
  /** Host advertises `agent-session.queued-messages.v1` and the transport has a fence. */
  enabled: boolean
  queuedMessages: readonly AgentSessionQueuedMessage[] | null
  submissions: readonly AgentJournalSubmission[]
  /** The turn in flight; with `submissions`, what a Stop press was aimed at. */
  turnId: string | null
  hasPendingPrompt: boolean
  composerScopeKey: string | undefined
  /** Scope for a clear's restore, which lands in the replacement session's pane. */
  composerScopeKeyForSession: ((sessionId: string) => string) | undefined
  mutate: StructuredAgentSessionMutate
  write: StructuredAgentSessionWrite
  /** The id `write` would reuse for a request: an unconfirmed clear's next press replays it. */
  operationIdFor: (fingerprintMethod: string, fields: Record<string, unknown>) => string
}): StructuredAgentSessionQueuedMessagesController {
  const {
    composerScopeKey,
    composerScopeKeyForSession,
    enabled,
    hasPendingPrompt,
    mutate,
    operationIdFor,
    queuedMessages,
    sessionId,
    submissions,
    turnId,
    write
  } = args

  const cards = useMemo(
    () => projectQueuedMessageCards(queuedMessages, submissions, { hasPendingPrompt }),
    [hasPendingPrompt, queuedMessages, submissions]
  )
  const cardsRef = useRef(cards)
  useEffect(() => {
    cardsRef.current = cards
  }, [cards])
  const workRef = useRef({ turnId, submissions })
  useEffect(() => {
    workRef.current = { turnId, submissions }
  }, [submissions, turnId])

  const restore = useCallback(
    (
      operationId: string,
      withdrawn: readonly AgentSessionWithdrawnQueuedMessage[],
      scopeKey: string | undefined,
      alreadyRestored: readonly string[] = []
    ): void =>
      completeQueuedWithdrawal(sessionId, operationId, withdrawn, scopeKey, { alreadyRestored }),
    [sessionId]
  )

  // One action per card at a time: a double-click or a chord repeat is not a second request.
  const actingOnRef = useRef(new Set<string>())
  const actOnce = useCallback(
    async (messageId: string, action: () => Promise<void>): Promise<void> => {
      if (actingOnRef.current.has(messageId)) {
        return
      }
      actingOnRef.current.add(messageId)
      try {
        await action()
      } finally {
        actingOnRef.current.delete(messageId)
      }
    },
    []
  )

  const steer = useCallback(
    (messageId: string): Promise<void> =>
      actOnce(messageId, async () => {
        await mutate<AgentSessionSendResult>(
          'agentSession.queuedMessageSend',
          'agentSession.queuedMessageSend',
          { messageId }
        )
      }),
    [actOnce, mutate]
  )

  const remove = useCallback(
    (messageId: string): Promise<void> =>
      actOnce(messageId, async () => {
        const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
          'agentSession.queuedMessageDelete',
          'agentSession.queuedMessageDelete',
          { messageId }
        )
        if (result && !result.deleted && result.disposition === 'dispatched') {
          alreadySentNotice()
        }
      }),
    [actOnce, mutate]
  )

  const editOnce = useCallback(
    async (messageId: string): Promise<void> => {
      const operationId = structuredSessionOperationId()
      // Before the RPC, so a replayed answer within this session restores once.
      // A failed marker write must not block Edit.
      beginQueuedWithdrawal(sessionId, {
        operationId,
        kind: 'edit',
        messageId,
        beganAt: Date.now()
      })
      const outcome = await writeQueuedWithdrawal<AgentSessionQueuedMessageDeleteResult>(
        write,
        'agentSession.queuedMessageDelete',
        { messageId },
        operationId
      )
      if (outcome.kind === 'done') {
        restore(
          operationId,
          outcome.value.deleted
            ? [{ messageId: outcome.value.messageId, body: outcome.value.body }]
            : [],
          composerScopeKey
        )
        if (!outcome.value.deleted && outcome.value.disposition === 'dispatched') {
          alreadySentNotice()
        }
        return
      }
      // Refused, or still unanswered after the replays: released. The host keeps an
      // unwithdrawn draft visible as a card.
      abandonQueuedWithdrawal(sessionId, operationId)
      if (outcome.kind === 'not-done') {
        toast.error(outcome.notice)
      }
    },
    [composerScopeKey, restore, sessionId, write]
  )
  const edit = useCallback(
    (messageId: string): Promise<void> => actOnce(messageId, () => editOnce(messageId)),
    [actOnce, editOnce]
  )

  const steerNewest = useCallback((): boolean => {
    if (!enabled) {
      return false
    }
    const newest = newestSteerableQueuedMessageCard(cardsRef.current)
    if (!newest) {
      return false
    }
    void steer(newest.messageId)
    return true
  }, [enabled, steer])

  const stopWithdrawing = useCallback(
    async (alreadyRestored: readonly string[] = []): Promise<AgentSessionCancelResult | null> => {
      const operationId = structuredSessionOperationId()
      beginQueuedWithdrawal(sessionId, { operationId, kind: 'stop', beganAt: Date.now() })
      const pressed = workRef.current
      const outcome = await writeQueuedWithdrawal<AgentSessionCancelResult>(
        write,
        'agentSession.cancel',
        { withdrawQueued: true },
        operationId,
        () => isStillPressedWork(pressed, workRef.current)
      )
      if (outcome.kind === 'done') {
        restore(operationId, outcome.value.withdrawnQueued ?? [], composerScopeKey, alreadyRestored)
        return outcome.value
      }
      // Refused, or still unanswered after the replays: released. Unwithdrawn
      // drafts stay visible as cards on the host's list.
      abandonQueuedWithdrawal(sessionId, operationId)
      if (outcome.kind === 'not-done') {
        toast.error(outcome.notice)
      }
      return null
    },
    [composerScopeKey, restore, sessionId, write]
  )

  const writeConversationCommand = useCallback(
    async (
      command: AgentSessionConversationCommand
    ): Promise<StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>> => {
      const method = 'agentSession.conversationCommand'
      if (command !== 'clear' || !enabled) {
        return write<AgentSessionConversationCommandResult>(method, method, { command })
      }
      // Opts into withdrawing drafts; an older host's strict schema never sees the key.
      const fields = { command, withdrawQueued: true }
      // The id write would reuse: the host refuses any other clear while one is unconfirmed.
      const operationId = operationIdFor(method, fields)
      beginQueuedWithdrawal(sessionId, { operationId, kind: 'clear', beganAt: Date.now() })
      const outcome = await writeQueuedWithdrawal<AgentSessionConversationCommandResult>(
        write,
        method,
        fields,
        operationId
      )
      if (outcome.kind !== 'done') {
        // Refused, or still unanswered after the replays: released. An unapplied
        // clear leaves the source and its cards untouched.
        abandonQueuedWithdrawal(sessionId, operationId)
        return outcome
      }
      const replacement = outcome.value.replacementSessionId
      const scopeKey = replacement
        ? (composerScopeKeyForSession?.(replacement) ?? composerScopeKey)
        : composerScopeKey
      restore(operationId, outcome.value.withdrawnQueued ?? [], scopeKey)
      return outcome
    },
    [
      composerScopeKey,
      composerScopeKeyForSession,
      enabled,
      operationIdFor,
      restore,
      sessionId,
      write
    ]
  )

  // A marker left by a crash is RELEASED, never replayed: an operation-id replay
  // that was never admitted would EXECUTE the command, so a reopened chat could be
  // cleared, or new work stopped, by a press from before the crash. The client has
  // no wire method to ask for an operation's recorded outcome without running it.
  // Crash-before-reach loses nothing — the host still holds the drafts and shows
  // them as cards. A crash (or a fence move) between the host's withdrawal commit
  // and this restore strands the text in its op-stamped tombstones; closing that
  // needs a wire-level outcome lookup, deliberately not added here.
  const recoveredRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || recoveredRef.current === sessionId) {
      return
    }
    recoveredRef.current = sessionId
    for (const pending of pendingQueuedWithdrawals(sessionId)) {
      abandonQueuedWithdrawal(sessionId, pending.operationId)
    }
  }, [enabled, sessionId])

  return {
    cards,
    steer,
    remove,
    edit,
    steerNewest,
    stopWithdrawing,
    writeConversationCommand
  }
}

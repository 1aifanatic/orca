// Host-held drafts as this pane acts on them: the card list, Send-now (Steer),
// Delete, Edit (withdraw-to-composer), and the write-ahead withdrawal restore
// Stop and /clear share. Everything durable lives on the host; this hook keeps
// only presentation and the restore bookkeeping the write-ahead contract needs.

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AgentJournalSubmission } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionConversationCommandResult } from '../../../../shared/agent-session-conversation-command'
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
  pendingQueuedWithdrawals
} from './structured-agent-session-queued-restore'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'
import type {
  StructuredAgentSessionMutate,
  StructuredAgentSessionWrite
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
  /** Write-ahead marker for a /clear about to run; null when the host keeps no drafts. */
  beginClearWithdrawal: () => string | null
  /** Restore what the clear's answer carried; the replacement session's pane gets the text. */
  settleClearWithdrawal: (
    operationId: string,
    result: AgentSessionConversationCommandResult | null
  ) => void
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
  hasPendingPrompt: boolean
  composerScopeKey: string | undefined
  /** Scope for a clear's restore, which lands in the replacement session's pane. */
  composerScopeKeyForSession: ((sessionId: string) => string) | undefined
  mutate: StructuredAgentSessionMutate
  write: StructuredAgentSessionWrite
}): StructuredAgentSessionQueuedMessagesController {
  const {
    composerScopeKey,
    composerScopeKeyForSession,
    enabled,
    hasPendingPrompt,
    mutate,
    queuedMessages,
    sessionId,
    submissions,
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

  const steer = useCallback(
    async (messageId: string): Promise<void> => {
      await mutate<AgentSessionSendResult>(
        'agentSession.queuedMessageSend',
        'agentSession.queuedMessageSend',
        { messageId }
      )
    },
    [mutate]
  )

  const remove = useCallback(
    async (messageId: string): Promise<void> => {
      const result = await mutate<AgentSessionQueuedMessageDeleteResult>(
        'agentSession.queuedMessageDelete',
        'agentSession.queuedMessageDelete',
        { messageId }
      )
      if (result && !result.deleted && result.disposition === 'dispatched') {
        alreadySentNotice()
      }
    },
    [mutate]
  )

  const edit = useCallback(
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
      const outcome = await write<AgentSessionQueuedMessageDeleteResult>(
        'agentSession.queuedMessageDelete',
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
      // Refused or lost: nothing replays a marker (see the recovery note below),
      // so it is released. The host keeps an unwithdrawn draft visible as a card.
      abandonQueuedWithdrawal(sessionId, operationId)
      if (outcome.kind === 'not-done') {
        toast.error(outcome.notice)
      }
    },
    [composerScopeKey, restore, sessionId, write]
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
      const outcome = await write<AgentSessionCancelResult>(
        'agentSession.cancel',
        'agentSession.cancel',
        { withdrawQueued: true },
        operationId
      )
      if (outcome.kind === 'done') {
        restore(operationId, outcome.value.withdrawnQueued ?? [], composerScopeKey, alreadyRestored)
        return outcome.value
      }
      // Refused or lost: released, never replayed — a replay could execute a new
      // Stop. Unwithdrawn drafts stay visible as cards on the host's list.
      abandonQueuedWithdrawal(sessionId, operationId)
      if (outcome.kind === 'not-done') {
        toast.error(outcome.notice)
      }
      return null
    },
    [composerScopeKey, restore, sessionId, write]
  )

  const beginClearWithdrawal = useCallback((): string | null => {
    if (!enabled) {
      return null
    }
    const operationId = structuredSessionOperationId()
    beginQueuedWithdrawal(sessionId, { operationId, kind: 'clear', beganAt: Date.now() })
    return operationId
  }, [enabled, sessionId])

  const settleClearWithdrawal = useCallback(
    (operationId: string, result: AgentSessionConversationCommandResult | null): void => {
      if (result === null) {
        // Refused or lost: released, never replayed — a replay could execute the
        // clear. An unapplied clear leaves the source and its cards untouched.
        abandonQueuedWithdrawal(sessionId, operationId)
        return
      }
      const scopeKey = result.replacementSessionId
        ? (composerScopeKeyForSession?.(result.replacementSessionId) ?? composerScopeKey)
        : composerScopeKey
      restore(operationId, result.withdrawnQueued ?? [], scopeKey)
    },
    [composerScopeKey, composerScopeKeyForSession, restore, sessionId]
  )

  // A marker left by a crash is RELEASED, never replayed: an operation-id replay
  // that was never admitted would EXECUTE the command, so a reopened chat could be
  // cleared, or new work stopped, by a press from before the crash. The client has
  // no wire method to ask for an operation's recorded outcome without running it.
  // Crash-before-reach loses nothing — the host still holds the drafts and shows
  // them as cards. Only a crash inside the window between the host's withdrawal
  // commit and this restore strands the text in its op-stamped tombstones; closing
  // that window needs a wire-level outcome lookup, deliberately not added here.
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
    beginClearWithdrawal,
    settleClearWithdrawal
  }
}

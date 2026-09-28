import { useMemo, useRef } from 'react'
import * as structuredConversationCommands from './structured-conversation-command-send'
import type { AgentSessionPromptResult } from '../../../../shared/agent-session-wire'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  supportsStructuredAgentSessionPromptCancel,
  supportsStructuredAgentSessionQuestionAnswers
} from '@/runtime/structured-agent-session-client'
import {
  useStructuredAgentSessionHostQueuesMessages,
  useStructuredAgentSessionHostStopsConversation
} from '@/runtime/structured-agent-session-host-capability'
import { hasUnsentStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  legacyAgentSessionSelectedOptionId,
  type AgentSessionPromptResponse
} from '../../../../shared/agent-session-question-answer'
import {
  pendingStructuredSessionPrompts,
  type StructuredPromptItem
} from './structured-agent-session-message-projection'
import { useStructuredAgentSessionMessages } from './use-structured-agent-session-messages'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import { useStructuredAgentSessionTransport } from './use-structured-agent-session-transport'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionThreadGoal } from './use-structured-agent-session-thread-goal'
import { useStructuredAgentSessionContextUsage } from './use-structured-agent-session-context-usage'
import { useStructuredAgentSessionRailOutline } from './use-structured-agent-session-rail-outline'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { outboxOutsideQueuedCards } from './structured-agent-session-queued-cards'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'

export type { StructuredPromptItem } from './structured-agent-session-message-projection'

type StructuredPromptCancelTarget = { itemId: string; expectedRevision: number }

export function useStructuredAgentSession(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  isVisible: boolean
  transportEnabled?: boolean
  /** The host has published the session but its provider has not answered startup yet. */
  providerStarting?: boolean
  /** This view started the session; only then does the stored selection name what it runs. */
  launch?: StructuredAgentSessionLaunchView
  /** The composer that gets back what a Stop withdrew. */
  composerScopeKey?: string
  /** The tab showing this chat; a /clear's restore targets the replacement session's pane. */
  tabId?: string
  /** The chat-wide "queue follow-ups" setting; off keeps mid-turn sends immediate. */
  queueFollowUps?: boolean
}) {
  const {
    agent,
    composerScopeKey,
    isVisible,
    launch,
    providerStarting = false,
    queueFollowUps = true,
    sessionId,
    tabId,
    target,
    transportEnabled = true
  } = args
  const {
    state,
    loadingOlder,
    olderHistoryGeneration,
    loadOlder,
    mutate,
    write,
    operationIdFor,
    providerVisible
  } = useStructuredAgentSessionTransport({
    sessionId,
    target,
    isVisible,
    enabled: transportEnabled
  })
  const commandPending = useRef(false)
  const transportState = useStructuredAgentSessionTransportState(state, transportEnabled)
  const {
    conversationCommands,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    threadGoal: threadGoalSupport,
    contextUsage: contextUsageSupport
  } = useStructuredAgentSessionOptions({
    agent,
    sessionId,
    target,
    transportEnabled,
    isVisible,
    providerVisible,
    providerStarting,
    fence: state.fence,
    turnId: transportState.turnId,
    unloadedTurnRevisions: state.unloadedTurnRevisions,
    mutate,
    ...(launch ? { launch } : {})
  })
  // Only a capable host may see `delivery`, the queuedMessage RPCs, or `withdrawQueued`;
  // against anything older this client must look exactly like today's.
  const queueCapable = useStructuredAgentSessionHostQueuesMessages(target)
  const queuedMessageIds = useMemo(
    () => (transportState.queuedMessages ?? []).map((message) => message.messageId),
    [transportState.queuedMessages]
  )
  const outboxController = useStructuredAgentSessionOutbox({
    sessionId,
    target,
    fence: transportState.fence,
    submissions: transportState.submissions,
    composerScopeKey,
    queueDelivery: queueCapable && queueFollowUps,
    queuedMessageIds
  })

  const threadGoal = useStructuredAgentSessionThreadGoal({
    journalItems: transportState.journalItems,
    support: threadGoalSupport,
    mutate
  })
  const contextUsage = useStructuredAgentSessionContextUsage(
    transportState.journalItems,
    contextUsageSupport
  )

  const railOutline = useStructuredAgentSessionRailOutline({
    sessionId,
    target,
    state,
    enabled: providerVisible
  })

  const prompts = pendingStructuredSessionPrompts(transportState.journalItems)
  const { outbox } = outboxController
  // A host that takes a Stop naming no turn gets Stop from the send until the work settles; every
  // Stop before a turn opens needs that form. An older host can stop only a turn it has opened.
  const stopsConversation =
    useStructuredAgentSessionHostStopsConversation(target) && transportState.fence !== null
  const canStop =
    transportState.turnId !== null ||
    (stopsConversation &&
      (transportState.isWorking ||
        hasUnsentStructuredAgentSessionOutboxEntry(
          outbox,
          transportState.submissions,
          outboxController.blockedClientMessageId
        )))
  // A queued send is a card, never a transcript bubble.
  const isWorking = transportState.isWorking
  const transcriptOutbox = useMemo(
    () =>
      outboxOutsideQueuedCards(
        outbox,
        queuedMessageIds,
        isWorking,
        outboxController.blockedClientMessageId
      ),
    [isWorking, outbox, outboxController.blockedClientMessageId, queuedMessageIds]
  )
  const messages = useStructuredAgentSessionMessages(
    transportState.journalItems,
    transcriptOutbox,
    transportState.submissions
  )
  const queuedController = useStructuredAgentSessionQueuedMessages({
    sessionId,
    enabled: queueCapable && transportState.fence !== null,
    queuedMessages: transportState.queuedMessages,
    submissions: transportState.submissions,
    turnId: transportState.turnId,
    hasPendingPrompt: prompts.length > 0,
    composerScopeKey,
    composerScopeKeyForSession: tabId
      ? (targetSessionId: string) => structuredAgentSessionPaneKey(tabId, targetSessionId)
      : undefined,
    mutate,
    write,
    operationIdFor
  })
  return {
    conversationCommands,
    runConversationCommand: (command: AgentSessionConversationCommand) =>
      structuredConversationCommands.sendStructuredConversationCommand({
        command,
        pending: commandPending,
        blocked: Boolean(
          transportState.turnId ||
          prompts.length ||
          transportState.backgroundTasks.isMonitoring ||
          outbox.length
        ),
        send: queuedController.writeConversationCommand
      }),
    journalItems: transportState.journalItems,
    messages,
    status: transportEnabled ? state.status : 'ready',
    error: transportEnabled ? (state.error ?? outboxController.error) : outboxController.error,
    hasOlder: transportEnabled && state.hasOlder,
    railOutline: transportEnabled ? railOutline : null,
    loadingOlder: transportEnabled && loadingOlder,
    olderHistoryGeneration,
    loadOlder,
    prompts,
    outbox,
    blockedClientMessageId: outboxController.blockedClientMessageId,
    send: (...input: Parameters<typeof outboxController.send>) =>
      !commandPending.current && outboxController.send(...input),
    retry: outboxController.retry,
    isWorking: transportState.isWorking,
    workingStartedAt: transportState.turnTiming.workingStartedAt,
    settledTurns: transportState.turnTiming.settledTurns,
    turnActivity: transportState.turnActivity,
    backgroundTasks: transportState.backgroundTasks,
    turnId: transportState.turnId,
    canStop,
    stop: () => {
      if (stopsConversation) {
        const restoredLocally = outboxController.withdrawUnsent()
        if (!queueCapable) {
          return mutate('agentSession.cancel', 'agentSession.cancel', {})
        }
        // Withdraw host-held drafts too, independent of the queue-follow-ups setting:
        // drafts queued before it was turned off still restore. Ids this client's own
        // outbox withdrawal just restored are excluded, and entries the host answered
        // for retire without a second restore — text never comes back twice.
        return queuedController.stopWithdrawing(restoredLocally).then((result) => {
          const withdrawn = result?.withdrawnQueued ?? []
          if (withdrawn.length > 0) {
            outboxController.retire(withdrawn.map((message) => message.messageId))
          }
          return result
        })
      }
      return transportState.turnId
        ? mutate('agentSession.cancel', 'agentSession.cancel', { turnId: transportState.turnId })
        : Promise.resolve(null)
    },
    queuedMessages: queuedController,
    cancel: async (turnId: string, prompt?: StructuredPromptCancelTarget) => {
      // Capability negotiation must complete before mutate constructs the payload
      // fingerprint and operation id: older hosts reject the strict prompt field.
      const promptSupported =
        prompt !== undefined && (await supportsStructuredAgentSessionPromptCancel(target))
      return mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId,
        ...(promptSupported ? { prompt } : {})
      })
    },
    stopBackgroundTask: (taskId?: string) =>
      mutate('agentSession.cancel', 'agentSession.cancel', {
        turnId: 'background-tasks',
        scope: 'background-tasks',
        ...(taskId ? { taskId } : {})
      }),
    respond: async (item: StructuredPromptItem, response: AgentSessionPromptResponse) => {
      const promptTarget = { itemId: item.itemId, expectedRevision: item.revision }
      let fields: Record<string, unknown>
      if (response.kind === 'option') {
        fields = { ...promptTarget, optionId: response.optionId }
      } else if (await supportsStructuredAgentSessionQuestionAnswers(target)) {
        // Negotiated before mutate fingerprints the call: older hosts reject the strict field.
        fields = { ...promptTarget, answers: response.answers }
      } else {
        const optionId =
          item.body.kind === 'question'
            ? legacyAgentSessionSelectedOptionId(item.body, response.answers)
            : null
        if (optionId === null) {
          return null
        }
        fields = { ...promptTarget, optionId }
      }
      return mutate<AgentSessionPromptResult>(
        item.body.kind === 'approval'
          ? 'agentSession.respondToApproval'
          : 'agentSession.respondToQuestion',
        `agentSession.respondTo:${item.body.kind}`,
        fields
      )
    },
    optionSnapshot,
    optionSurface,
    sessionCommands: transportEnabled ? (state.commands ?? undefined) : undefined,
    setStructuredOption,
    threadGoal,
    contextUsage
  }
}

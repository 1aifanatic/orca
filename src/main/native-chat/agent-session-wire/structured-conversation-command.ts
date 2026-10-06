import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import { sendPreparation } from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { committedClearOfCaller } from './structured-conversation-command-admission'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import {
  clearConversationUnderSerialize,
  QUEUED_CLEAR_CALLER_KEY,
  structuredAgentSessionClearBody
} from './structured-conversation-clear'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'

/** A command's `error` is the sentence its row shows. */
export function conversationCommandFailure(
  failure: AgentSessionFailureFact | undefined,
  context: AgentSessionFailureWordsContext = {}
) {
  if (!failure) {
    return {}
  }
  const words = agentSessionFailureWords(failure, { ...context, surface: 'row' })
  return { error: words.text, failure: words.failure }
}

export type ConversationCommandParams = {
  envelope: AgentSessionMutationEnvelope
  command: AgentSessionConversationCommand
  /** Wait as a card while the agent works, as a queued send does. */
  delivery?: 'queue-if-active'
}
export type ConversationReplacement = {
  sourceSessionId: string
  sessionId: string
  workspaceId: string
  agent: StructuredAgentId
}

const clearFingerprintsOf = (sessionId: string) =>
  [{ command: 'clear' }, { command: 'clear', delivery: 'queue-if-active' }].map((fields) =>
    computeAgentSessionPayloadFingerprint({
      method: 'agentSession.conversationCommand',
      sessionId,
      fields
    })
  )

/** This caller's committed /clear, for a /clear it presses again on the conversation that one
 *  cleared. Answered before admission, which would refuse it as cleared. */
async function answerFromCommittedClear(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  { envelope, command }: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult> | null> {
  const { store } = context.deps
  const record = store.getRecord(envelope.sessionId)
  const committed =
    command === 'clear' &&
    clearFingerprintsOf(envelope.sessionId).includes(envelope.payloadFingerprint)
      ? committedClearOfCaller(record, caller.callerKey, store.getSessionTabId(envelope.sessionId))
      : null
  const session =
    committed && (await context.openConversation(envelope.sessionId).catch(() => null))
  return record && committed && session
    ? {
        ok: true,
        replayed: true,
        fence: record.lease.runtimeFence,
        cursor: session.journal.cursor(),
        value: committed
      }
    : null
}

/**
 * `/clear`: one write that points this conversation at a new, at-rest one and moves its tab there
 * (`clearConversationUnderSerialize`). The new conversation's first send starts its agent. Asked
 * with `delivery` while the agent works, it waits as a card, answered at once.
 */
export function runStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  const { envelope, command } = params
  const { sessionId, clientOperationId } = envelope
  const store = context.deps.store
  /** For a replay, once the ledger has proved this caller owns the id: the clear it committed,
   *  or the one the queue ran for its card, recorded under the queue's own key. */
  const replayedClear = () => {
    const record = store.getRecord(sessionId)?.conversationCommand
    return record?.operationId === clientOperationId &&
      (record.callerKey === caller.callerKey || record.callerKey === QUEUED_CLEAR_CALLER_KEY)
      ? record
      : null
  }
  return context.serialize(sessionId, async () => {
    const committed = await answerFromCommittedClear(context, caller, params)
    if (committed) {
      return committed
    }
    return admitAndRunAgentSessionMutation({
      store,
      adapter: context.deps.adapter,
      agents: context.deps.agents,
      logger: context.deps.logger,
      callerKey: caller.callerKey,
      envelope,
      // Starts the agent only to settle a rewind in doubt, as a send does; a /clear itself starts nothing.
      prepareSession: sendPreparation(context, envelope, { refusesInRun: true }),
      journal: () => context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      now: context.now,
      plan: {
        method: 'agentSession.conversationCommand',
        fields: { command, ...(params.delivery ? { delivery: params.delivery } : {}) },
        // Written to the conversation, not the agent, so whoever owns the agent does not matter.
        conversationWrite: true,
        recoverUnknownFromDurableState: true,
        settledOutcome: (value) => ({ status: 'succeeded', sessionId, conversationCommand: value }),
        replay: (replayCtx, outcome) => {
          // What the clear did outranks the receipt its card was answered with.
          const prior = replayedClear()
          if (prior?.phase === 'committed') {
            return prior
          }
          if (outcome.status === 'succeeded' && outcome.conversationCommand) {
            return outcome.conversationCommand
          }
          // Its card answers until the queue runs it; the card is keyed by this operation id.
          const card = queuedSendAnswer(replayCtx.journal, clientOperationId)
          return card && 'queued' in card
            ? { command: 'clear', state: 'completed', queued: card.queued }
            : null
        },
        // The commit and the card are its only writes, so with neither answering it changed nothing.
        rerunWhenReplayMissing: () => true,
        run: async (ctx) => {
          if (params.delivery) {
            // The queue's own accept rule decides first, as for /compact: whatever a queued send
            // waits behind, the clear waits behind too, and the host runs it when its turn comes.
            const queued = await maybeQueueStructuredAgentSessionSend(context, ctx, {
              envelope,
              body: structuredAgentSessionClearBody(),
              delivery: params.delivery
            })
            if (queued && !queued.ok) {
              return queued
            }
            if (queued && 'queued' in queued.value) {
              return {
                ok: true,
                value: { command: 'clear', state: 'completed', queued: queued.value.queued }
              }
            }
          }
          return clearConversationUnderSerialize(context, ctx, {
            operationId: clientOperationId,
            callerKey: caller.callerKey
          })
        }
      }
    })
  })
}

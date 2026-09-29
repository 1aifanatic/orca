import { createHash } from 'node:crypto'
import { isDefinitiveAgentSessionCreateRefusal } from '../../../shared/agent-session-definitive-refusal'
import { parseAgentSessionOperationTimestamp } from '../../../shared/agent-session-host-authority'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { agentSessionLeaseIsReleased } from '../../../shared/agent-session-lease-adjudication'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { admitAndRunAgentSessionMutation } from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  openWithAgent,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { AgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailureFact } from './structured-agent-session-failure-text'

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
}
export type ConversationReplacement = {
  sourceSessionId: string
  sessionId: string
  workspaceId: string
  agent: 'claude' | 'codex'
}

export function runStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  host: Pick<StructuredAgentSessionHost, 'attach' | 'flushStreamedEvents'>,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): Promise<AgentSessionMutationResult<AgentSessionConversationCommandResult>> {
  const { envelope, command } = params
  const { sessionId, clientOperationId } = envelope
  const store = context.deps.store
  const matching = () => {
    const record = store.getRecord(sessionId)?.conversationCommand
    return record?.operationId === clientOperationId && record.callerKey === caller.callerKey
      ? record
      : null
  }
  return context.serialize(sessionId, () =>
    admitAndRunAgentSessionMutation({
      store,
      adapter: context.deps.adapter,
      callerKey: caller.callerKey,
      envelope,
      // Only the provider can do this, so an agent at rest is started first.
      prepareSession: openWithAgent(context, params.envelope),
      journal: () => context.sessions.get(sessionId)?.journal,
      publish: (journal) => context.publish(sessionId, journal),
      flushStreamedEvents: context.flushStreamedEvents,
      now: context.now,
      plan: {
        method: 'agentSession.conversationCommand',
        fields: { command },
        recoverUnknownFromDurableState: true,
        settledOutcome: (value) => ({ status: 'succeeded', sessionId, conversationCommand: value }),
        replay: (_ctx, outcome) => {
          if (outcome.status === 'succeeded' && outcome.conversationCommand) {
            return outcome.conversationCommand
          }
          const prior = matching()
          return prior?.phase === 'committed' ? prior : null
        },
        // Nothing the chat reads is written before the commit, so a clear with no committed answer
        // changed nothing and runs again under the same replacement id.
        rerunWhenReplayMissing: () => command === 'clear',
        run: async (ctx) => {
          await host.flushStreamedEvents(sessionId)
          const record = store.getRecord(sessionId)!
          const blocked = conversationCommandBlocked(ctx, record)
          if (blocked) {
            return { ok: false, refusal: blocked }
          }
          const replacementSessionId =
            command === 'clear'
              ? `clear-${createHash('sha256')
                  .update(JSON.stringify([sessionId, caller.callerKey, clientOperationId]))
                  .digest('hex')
                  .slice(0, 40)}`
              : undefined
          const base = {
            command,
            runtimeFence: ctx.fence,
            operationId: clientOperationId,
            callerKey: caller.callerKey,
            ...(replacementSessionId ? { replacementSessionId } : {})
          }
          if (command === 'clear' && replacementSessionId) {
            const attach: AgentSessionAttachParams = {
              envelope: {
                sessionId: replacementSessionId,
                clientOperationId: `${parseAgentSessionOperationTimestamp(clientOperationId)}-${createHash(
                  'sha256'
                )
                  .update(JSON.stringify([sessionId, caller.callerKey, clientOperationId]))
                  .digest('hex')
                  .slice(0, 32)}`,
                expectedRuntimeFence: null,
                payloadFingerprint: ''
              },
              location: record.location,
              accountHome: record.accountHome,
              provider: record.provider,
              agent: record.provider,
              runtimeKind: 'native',
              launchArgs: record.launchArgs,
              // The options the user chose, which any restart of this chat would replay too.
              options: record.options
            }
            attach.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
              method: 'agentSession.attach',
              sessionId: replacementSessionId,
              fields: attachFingerprintFields(attach)
            })
            const acquired = await host.attach(caller, attach)
            const replacement = store.getRecord(replacementSessionId)
            // An earlier try started this replacement and a restart or the idle sweep has since
            // stopped it: attach can't replay a settled start, but the new conversation is at rest.
            const startedAndAtRest =
              replacement !== null &&
              agentSessionLeaseIsReleased(replacement.lease) &&
              store.getOperationRow(caller.callerKey, attach.envelope.clientOperationId)?.outcome
                .status === 'succeeded'
            if (!acquired.ok && !startedAndAtRest) {
              if (
                !isDefinitiveAgentSessionCreateRefusal(acquired.refusal.code) &&
                replacement?.lease.claimStatus !== 'released'
              ) {
                throw new Error(acquired.refusal.message)
              }
              // The refusal's message is Orca's log text; the result keeps its situation instead.
              const failed = {
                ...base,
                replacementSessionId: undefined,
                phase: 'committed' as const,
                state: 'completed' as const,
                ...conversationCommandFailure(
                  structuredAgentSessionStartFailureFact({
                    refusal: acquired.refusal,
                    newSession: true
                  }),
                  { ...structuredAgentSessionFailureWordsContext(record), command: 'clear' }
                )
              }
              await store.setConversationCommand(sessionId, ctx.fence, failed)
              return { ok: true, value: failed }
            }
          }
          const completed = {
            ...base,
            phase: 'committed' as const,
            state: 'completed' as const
          }
          await store.setConversationCommand(sessionId, ctx.fence, completed)
          return { ok: true, value: completed }
        }
      }
    })
  )
}

// `agentSession.subscribeTurnCompletions` — every structured turn that settles from now on, and,
// for a client that asks with `includePrompts`, every approval or question newly put to the user.
//
// Separate from `agentSession.subscribeStatus` because it answers a different question. Status is
// state a late subscriber still needs, so that stream opens with a snapshot of every session. A
// completion is an edge that has already passed, so this one opens with nothing and replays
// nothing: a client that was away during a completion has missed it, by decision.

import { defineMethod, defineStreamingMethod } from '../core'
import {
  requireInstalledStructuredHost,
  requireStructuredCapability,
  requireStructuredHost as requireHost
} from './structured-agent-session-gate'
import {
  AcknowledgeAttentionParams,
  SubscribeTurnCompletionsParams
} from './structured-agent-session-schemas'
import { structuredAgentSessionTurnCompletionSubscriptionId } from './structured-agent-session-subscription-id'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'

export const STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS = [
  // Retire only deliveries whose journal cause was included in the client's accepted read.
  defineMethod({
    name: 'agentSession.acknowledgeAttention',
    params: AcknowledgeAttentionParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      // Built if need be: after a restart the first read can arrive before any chat is opened.
      const host = await requireInstalledStructuredHost(ctx)
      const prefix = host.attentionSubjectPrefix(params.sessionId)
      if (prefix) {
        ctx.runtime.retireStructuredAttention(
          { sessionId: params.sessionId, observedCursor: params.observedCursor },
          prefix
        )
      }
      return { acknowledged: prefix !== null }
    }
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribeTurnCompletions',
    params: SubscribeTurnCompletionsParams,
    handler: async (params, ctx, emit) => {
      const host = requireHost(ctx)
      const subscriptionId = structuredAgentSessionTurnCompletionSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = host.subscribeTurnCompletions({
        id: subscriptionId,
        emit,
        includePrompts: params.includePrompts === true
      })
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]

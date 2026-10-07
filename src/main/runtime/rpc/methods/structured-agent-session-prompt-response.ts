// Answers to an agent's approvals and questions, its options, and read-only session facts.
import { defineMethod } from '../core'
import {
  requireInstalledStructuredHost as requireInstalledHost,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  HandoffStatusParams,
  OptionsParams,
  RespondParams,
  RespondToQuestionParams,
  SetOptionParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS = [
  defineMethod({
    name: 'agentSession.respondToApproval',
    permission: 'workspace',
    params: RespondParams,
    handler: async (params, ctx) =>
      requireHost(ctx).respondToPrompt(callerFor(ctx), { ...params, kind: 'approval' })
  }),
  defineMethod({
    name: 'agentSession.respondToQuestion',
    permission: 'workspace',
    params: RespondToQuestionParams,
    handler: async (params, ctx) =>
      requireHost(ctx).respondToPrompt(callerFor(ctx), { ...params, kind: 'question' })
  }),
  defineMethod({
    name: 'agentSession.setOption',
    permission: 'workspace',
    params: SetOptionParams,
    handler: async (params, ctx) => requireHost(ctx).setOption(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.handoffStatus',
    permission: 'workspace',
    params: HandoffStatusParams,
    handler: async (params, ctx) =>
      (await requireInstalledHost(ctx)).handoffStatus(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.commands',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => (await requireInstalledHost(ctx)).readCommands(params.sessionId)
  })
]

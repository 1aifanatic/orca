import { z } from 'zod'
import { acpNotificationEnvelopeSchema } from '../acp-context-usage'
import type { AcpDialect, AcpDialectNotification } from './acp-dialect'
import { grokRequest } from './grok-requests'
import { grokBackgroundTaskNotification, grokToolBackgroundTasks } from './grok-background-tasks'

const tokenCount = z.number().int().nonnegative()
const toolMetaSchema = z.object({ 'x.ai/tool': z.object({ name: z.string().min(1) }) })
const turnMetaSchema = z.looseObject({
  promptId: z.string().optional(),
  turnStartMs: tokenCount.optional()
})
const completionSchema = z.looseObject({
  sessionUpdate: z.literal('turn_completed'),
  prompt_id: z.string(),
  stop_reason: z.string(),
  elapsed_ms: tokenCount.optional()
})
const responseSchema = z.object({
  sessionUpdate: z.literal('response_completed'),
  usage: z.object({
    input_tokens: tokenCount,
    output_tokens: tokenCount.default(0),
    cache_read_input_tokens: tokenCount.default(0),
    cache_creation_input_tokens: tokenCount.default(0)
  })
})
const queueSchema = z.object({ sessionId: z.string(), runningPromptId: z.string().nullish() })
const modelsSchema = z.object({
  currentModelId: z.string().optional(),
  availableModels: z
    .array(
      z.object({
        modelId: z.string(),
        _meta: z.object({ totalContextTokens: z.number().int().positive() }).optional()
      })
    )
    .optional()
})

function contextWindow(models: unknown): number | undefined {
  const parsed = modelsSchema.safeParse(models)
  if (!parsed.success) {
    return undefined
  }
  const { currentModelId, availableModels = [] } = parsed.data
  return (
    availableModels.find((model) => model.modelId === currentModelId)?._meta?.totalContextTokens ??
    availableModels.find((model) => model._meta)?._meta?.totalContextTokens
  )
}

function notification(
  method: string,
  params: unknown,
  at: number
): AcpDialectNotification | undefined {
  const canonical = method.startsWith('_') ? method.slice(1) : method
  const backgroundTask = grokBackgroundTaskNotification(canonical, params)
  if (backgroundTask) {
    return backgroundTask
  }
  if (canonical === 'x.ai/models/update') {
    const tokens = contextWindow(params)
    return tokens === undefined
      ? { disposition: 'ignore' }
      : { disposition: 'map', usage: { window: { tokens, capturedAt: at } } }
  }
  if (canonical === 'x.ai/queue/changed') {
    const parsed = queueSchema.safeParse(params)
    return parsed.success && parsed.data.runningPromptId
      ? { disposition: 'map', turn: parsed.data.runningPromptId, started: true }
      : { disposition: 'ignore' }
  }
  if (
    method !== 'session/update' &&
    !['x.ai/session_notification', 'x.ai/session/update'].includes(canonical)
  ) {
    return canonical.startsWith('x.ai/') ? { disposition: 'ignore' } : undefined
  }
  const parsed = acpNotificationEnvelopeSchema.safeParse(params)
  if (!parsed.success) {
    return method === 'session/update' ? undefined : { disposition: 'ignore' }
  }
  const envelope = parsed.data
  const meta = turnMetaSchema.safeParse(envelope._meta)
  const completion = completionSchema.safeParse(envelope.update)
  const response = responseSchema.safeParse(envelope.update)
  if (method !== 'session/update' && !completion.success && !response.success) {
    return { disposition: 'ignore' }
  }
  const turn = completion.success
    ? completion.data.prompt_id
    : meta.success
      ? meta.data.promptId
      : undefined
  return {
    disposition: 'map',
    ...(turn === undefined ? {} : { turn }),
    ...(meta.success && meta.data.turnStartMs !== undefined ? { at: meta.data.turnStartMs } : {}),
    replay: envelope._meta?.isReplay === true,
    ...(completion.success
      ? {
          end: { stopReason: completion.data.stop_reason, durationMs: completion.data.elapsed_ms }
        }
      : {}),
    ...(response.success
      ? {
          usage: {
            used: {
              kind: 'estimate',
              capturedAt: at,
              usage: {
                inputTokens: response.data.usage.input_tokens,
                outputTokens: response.data.usage.output_tokens,
                cacheReadInputTokens: response.data.usage.cache_read_input_tokens,
                cacheCreationInputTokens: response.data.usage.cache_creation_input_tokens
              }
            }
          }
        }
      : {})
  }
}

export const GROK_ACP_DIALECT: AcpDialect = {
  injectedPromptIdentity: true,
  toolName: (update) => {
    const parsed = toolMetaSchema.safeParse(update._meta)
    return parsed.success ? parsed.data['x.ai/tool'].name : undefined
  },
  request: grokRequest,
  toolBackgroundTasks: grokToolBackgroundTasks,
  notification,
  contextWindow
}

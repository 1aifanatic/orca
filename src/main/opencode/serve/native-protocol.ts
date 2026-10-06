import { z } from 'zod'
import { OpenCodeHttpError } from './http-response'

export const openCodeObjectSchema = z.record(z.string(), z.unknown())
const nativeId = z.string().min(1).max(512)
export const openCodePermissionRuleSchema = z.object({
  permission: z.string().max(256),
  pattern: z.string().max(4096),
  action: z.enum(['allow', 'ask', 'deny'])
})
export type OpenCodePermissionRule = z.infer<typeof openCodePermissionRuleSchema>

export const openCodeModelSchema = z.object({
  providerID: z.string().max(256),
  id: z.string().max(512),
  variant: z.string().max(256).optional()
})
export type OpenCodeModel = z.infer<typeof openCodeModelSchema>

export const openCodeSessionSchema = z.object({
  id: nativeId,
  parentID: nativeId.optional(),
  directory: z.string().max(4096).optional(),
  location: z.object({ directory: z.string().max(4096) }).optional(),
  title: z.string().max(4096).optional(),
  agent: z.string().max(256).optional(),
  model: openCodeModelSchema.optional(),
  permission: openCodePermissionRuleSchema.array().max(256).optional(),
  permissions: z
    .array(
      z.object({
        action: z.string().max(256),
        resource: z.string().max(4096),
        effect: z.enum(['allow', 'ask', 'deny'])
      })
    )
    .max(256)
    .optional()
})
export type OpenCodeNativeSession = z.infer<typeof openCodeSessionSchema>

export type OpenCodeWireEvent = {
  type: string
  id?: string
  at?: number
  data: Record<string, unknown>
}

const eventSchema = z.object({
  id: nativeId.optional(),
  type: z.string().min(1),
  created: z.number().finite().optional(),
  properties: openCodeObjectSchema.optional(),
  data: openCodeObjectSchema.optional()
})
const globalEnvelopeSchema = z.object({ payload: z.unknown() })

/** 1.x may wrap a global event; 2.x reports the same session identity in `data`. */
export function readOpenCodeWireEvent(value: unknown, major: 1 | 2): OpenCodeWireEvent {
  const envelope = globalEnvelopeSchema.safeParse(value)
  const event = eventSchema.safeParse(envelope.success ? envelope.data.payload : value)
  const data = event.success ? (major === 1 ? event.data.properties : event.data.data) : undefined
  if (!event.success || !data) {
    throw new OpenCodeHttpError('invalid-response', 'OpenCode sent an unreadable event envelope')
  }
  return {
    type: event.data.type,
    ...(event.data.id === undefined ? {} : { id: event.data.id }),
    ...(event.data.created === undefined ? {} : { at: event.data.created }),
    data
  }
}

export function readOpenCodeSession(value: unknown, major: 1 | 2): OpenCodeNativeSession {
  const envelope = z.object({ data: z.unknown() }).safeParse(value)
  const session = openCodeSessionSchema.safeParse(
    major === 2 && envelope.success ? envelope.data.data : value
  )
  if (!session.success) {
    throw new OpenCodeHttpError('invalid-response', 'OpenCode did not return a session')
  }
  return session.data
}

export function openCodeV2PermissionRules(rules: readonly OpenCodePermissionRule[]): unknown[] {
  return rules.map(({ permission, pattern, action }) => ({
    action: permission === 'bash' ? 'shell' : permission === 'task' ? 'subagent' : permission,
    resource: pattern,
    effect: action
  }))
}

export function openCodeSessionPermissionRules(
  session: OpenCodeNativeSession,
  major: 1 | 2
): OpenCodePermissionRule[] | undefined {
  return major === 1
    ? session.permission
    : session.permissions?.map(({ action, resource, effect }) => ({
        permission: action === 'shell' ? 'bash' : action === 'subagent' ? 'task' : action,
        pattern: resource,
        action: effect
      }))
}

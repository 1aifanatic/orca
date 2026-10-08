import { z } from 'zod'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import { parseExecutionHostId } from '../../shared/execution-host'

/**
 * The terminal a create launches on its execution host, recorded with the claim before dispatch.
 * Identity only: the launch plan is re-derived by every attempt that may spawn, so no prompt, env
 * or command reaches disk, and this shape never follows the RPC params.
 */
const AgentSessionCreateTerminalTargetSchema = z.object({
  version: z.literal(1),
  executionOperationId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  worktreeId: z.string().min(1),
  connectionId: z.string().nullable(),
  terminalHandle: z.string().min(1),
  tabId: z.string().min(1),
  leafId: z.string().min(1)
})

export type AgentSessionCreateTerminalTarget = z.infer<
  typeof AgentSessionCreateTerminalTargetSchema
>

/** Strips anything outside the schema, so only identity is ever persisted. */
export function toAgentSessionCreateTerminalTarget(
  target: Omit<AgentSessionCreateTerminalTarget, 'version'>
): AgentSessionCreateTerminalTarget {
  return AgentSessionCreateTerminalTargetSchema.parse({ ...target, version: 1 })
}

export function readAgentSessionCreateTerminalTarget(
  value: unknown
): AgentSessionCreateTerminalTarget | null {
  const parsed = AgentSessionCreateTerminalTargetSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const RecordedTerminal = z.object({
  handle: z.string().min(1),
  ptyId: z.string().nullable().optional(),
  worktreeId: z.string().min(1),
  title: z.string().nullable(),
  tabId: z.string().optional(),
  paneKey: z.string().nullable().optional(),
  surface: z.enum(['background', 'visible']).optional(),
  warning: z.string().optional(),
  incarnationId: z.string().nullable().optional(),
  executionHostId: z.string().optional(),
  hostPlatform: z
    .enum([
      'aix',
      'android',
      'darwin',
      'freebsd',
      'haiku',
      'linux',
      'openbsd',
      'sunos',
      'win32',
      'cygwin',
      'netbsd'
    ])
    .optional(),
  agentSessionDisposition: z.enum(['created', 'adopted']).optional(),
  isReattach: z.literal(true).optional(),
  processId: z.number().optional()
})

export function readAgentSessionCreatedTerminal(value: unknown): RuntimeTerminalCreate | null {
  const parsed = RecordedTerminal.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const { executionHostId, ...terminal } = parsed.data
  const host = parseExecutionHostId(executionHostId)
  return { ...terminal, ...(host ? { executionHostId: host.id } : {}) }
}

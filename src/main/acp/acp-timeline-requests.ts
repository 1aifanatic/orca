import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect, AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { acpJournalTurnKey } from './acp-journal-turns'
import type { AcpToolTimeline } from './acp-tool-timeline'
import { AcpRpcError } from './acp-errors'
import { RequestPermissionRequestSchema } from './generated/acp-protocol.generated'

export const pendingAcpResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

export function acpPermissionPresentation(params: unknown): AcpRequestPresentation {
  const parsed = RequestPermissionRequestSchema.safeParse(params)
  if (!parsed.success) {
    throw new AcpRpcError(-32602, 'Invalid ACP permission request')
  }
  const { toolCall, options } = parsed.data
  return {
    body: {
      kind: 'approval',
      title: toolCall.title ?? 'Permission requested',
      detail: null,
      options: options.map((option) => ({ id: option.optionId, label: option.name })),
      resolution: pendingAcpResolution
    },
    reply: (response) => {
      if (response === null) {
        return { outcome: { outcome: 'cancelled' } }
      }
      if (
        response.kind !== 'option' ||
        !options.some((option) => option.optionId === response.optionId)
      ) {
        throw new AcpRpcError(-32602, 'Permission answer must select an offered option')
      }
      return { outcome: { outcome: 'selected', optionId: response.optionId } }
    }
  }
}

const requestSessionSchema = z.object({ sessionId: z.string() })
const requestToolSchema = z.object({
  toolCallId: z.string().optional(),
  toolCall: z.object({ toolCallId: z.string() }).optional()
})

export function translateAcpRequest(
  method: string,
  params: unknown,
  id: string | number,
  options: {
    sessionId: string
    journalItems(): readonly AgentJournalRenderItem[]
    dialect: AcpDialect
    tools: AcpToolTimeline
  }
): { events: ProviderTimelineEvent[]; presentation?: AcpRequestPresentation } {
  const session = requestSessionSchema.safeParse(params)
  if (!session.success || session.data.sessionId !== options.sessionId) {
    throw new AcpRpcError(-32602, 'ACP request belongs to an unknown session')
  }
  const presentation =
    method === 'session/request_permission'
      ? acpPermissionPresentation(params)
      : options.dialect.request?.(method, params)
  const tool = requestToolSchema.safeParse(params)
  const callId = tool.success ? (tool.data.toolCall?.toolCallId ?? tool.data.toolCallId) : undefined
  const storedTool = callId
    ? options
        .journalItems()
        .find((row) => row.body.kind === 'tool-call' && row.body.callId === callId)
    : undefined
  const turnItemId =
    storedTool?.turnScope?.kind === 'turn' ? storedTool.turnScope.turnItemId : undefined
  const storedTurn = options.journalItems().find((row) => row.itemId === turnItemId)
  const turn = callId
    ? (options.tools.turn(callId) ?? (storedTurn && acpJournalTurnKey(storedTurn)))
    : undefined
  const join = { thread: options.sessionId, ...(turn === undefined ? {} : { turn }) }
  if (!presentation) {
    return {
      events: [{ type: 'provider.frame', frameKind: `request:${method}`, payload: params, join }]
    }
  }
  return {
    presentation,
    events: [
      {
        type: 'request.open',
        request: `${method}:${JSON.stringify(id)}`,
        body: presentation.body,
        join
      }
    ]
  }
}

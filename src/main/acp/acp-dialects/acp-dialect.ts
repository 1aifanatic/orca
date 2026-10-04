import type { AgentSessionContextUsage } from '../../../shared/agent-session-context-usage'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session-question-answer'
import type { ProviderTimelineRequestBody } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'

export type AcpRequestPresentation = {
  body: ProviderTimelineRequestBody
  reply(response: AgentSessionPromptResponse | null): unknown
}

export type AcpDialectNotification =
  | { disposition: 'ignore' }
  | {
      disposition: 'map'
      turn?: string
      replay?: boolean
      at?: number
      started?: boolean
      end?: { stopReason: string; durationMs?: number }
      usage?: AgentSessionContextUsage
    }

/** Hooks interpret extensions; lifecycle and row identity stay shared. */
export type AcpDialect = {
  injectedPromptIdentity?: true
  toolName?(update: ToolCallUpdate): string | undefined
  notification?(method: string, params: unknown, at: number): AcpDialectNotification | undefined
  contextWindow?(models: unknown): number | undefined
  request?(method: string, params: unknown): AcpRequestPresentation | undefined
}

export const GENERIC_ACP_DIALECT: AcpDialect = {}

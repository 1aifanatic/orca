import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import { agentSessionProviderClaims } from '../../../shared/agent-session-provider-claims'

export type StructuredProviderSessionOwnership = {
  sessionId: string
  workspaceId: string
  provider: StructuredAgentId
  providerSessionId: string
  conversationName?: string
  lease: AgentSessionLease
}

export function listStructuredProviderSessionOwnership(
  records: readonly AgentSessionRecord[]
): StructuredProviderSessionOwnership[] {
  return agentSessionProviderClaims(records).map(({ record, handle }) => ({
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    provider: record.provider,
    providerSessionId: handle.nativeId,
    conversationName: record.conversationName,
    lease: record.lease
  }))
}

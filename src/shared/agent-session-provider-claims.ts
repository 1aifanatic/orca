import {
  agentSessionProviderContextStart,
  agentSessionProviderHandleRoot,
  type AgentSessionProviderHandle
} from './agent-session-provider-handle'
import type { AgentSessionRecord } from './agent-session-record'

export type AgentSessionProviderClaim = {
  record: AgentSessionRecord
  handle: AgentSessionProviderHandle
  archived: boolean
}

/** A downgraded host can adopt an invisible archive; its visible claim wins on upgrade. */
export function agentSessionProviderClaims(
  records: Iterable<AgentSessionRecord>
): AgentSessionProviderClaim[] {
  const byRoot = new Map<string, Map<string, AgentSessionProviderClaim>>()
  for (const record of records) {
    const start = agentSessionProviderContextStart(record.providerHandleChain)
    for (const [index, link] of record.providerHandleChain.entries()) {
      const root = agentSessionProviderHandleRoot(link.handle)
      const owners = byRoot.get(root) ?? new Map<string, AgentSessionProviderClaim>()
      const claim = { record, handle: link.handle, archived: index < start }
      const prior = owners.get(record.sessionId)
      if (!prior || !claim.archived) {
        owners.set(record.sessionId, claim)
      }
      byRoot.set(root, owners)
    }
  }
  return [...byRoot.values()].flatMap((owners) => {
    const claims = [...owners.values()]
    const visible = claims.filter((claim) => !claim.archived)
    if (visible.length > 0) {
      return visible
    }
    // Archives reserve identity; their display owner must not depend on database insertion order.
    const first = claims.reduce((left, right) =>
      left.record.sessionId < right.record.sessionId ? left : right
    )
    return [first]
  })
}

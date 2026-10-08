// Provider history for an attach's restart reconciliation, placed at the resume point it was read
// from. Reading is best effort: no reader, a failed read, or no history leaves every send exactly
// as the crash boundary wrote it.

import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  PlacedProviderHistoryWindow,
  ProviderHistoryWindow
} from '../agent-session-journal/journal-submission-reconciler'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'

export async function sampleProviderHistoryWindow(input: {
  adapter: StructuredAgentSessionAdapter
  identity: AgentSessionJournalIdentity
  /** The record `identity` came from, read before this attach acquires a child. */
  record: AgentSessionRecord
  ownerAlreadyAdmitted: boolean
}): Promise<PlacedProviderHistoryWindow | null> {
  const read = input.adapter.providerHistoryWindow
  if (!read) {
    return null
  }
  let history: ProviderHistoryWindow | null
  try {
    history = await read({ identity: input.identity, accountHome: input.record.accountHome })
  } catch {
    return null
  }
  if (!history) {
    return null
  }
  return {
    ...history,
    // A lease that was already live may belong to a provider child this process
    // has not indexed yet. Preserve the safe unknown outcome in that case.
    turnInFlight: history.turnInFlight || input.ownerAlreadyAdmitted,
    // The identity resumes from the chain head, and only the owner that minted a head moves it.
    startFence:
      agentSessionProviderHandleChainHead(input.record.providerHandleChain)?.mintedAtFence ?? null
  }
}

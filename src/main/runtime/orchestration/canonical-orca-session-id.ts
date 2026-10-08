import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import {
  clearedInto,
  readAgentSessionRecordStore,
  type AgentSessionRecordReader
} from './structured-session-lineage'

/**
 * The Orca session id orchestration addresses a session by: the first session of its `/clear`
 * lineage, so a cleared chat keeps the address, Runs and mail it had. Every session-to-party step
 * calls this. Without a record store there is no lineage to read, and the id stands for itself.
 */
export function canonicalOrcaSessionId(
  orcaSessionId: OrcaSessionId,
  store: AgentSessionRecordReader | null = readAgentSessionRecordStore()
): OrcaSessionId {
  if (!store) {
    return orcaSessionId
  }
  return createCanonicalOrcaSessionIdResolver(store)(orcaSessionId)
}

/** One record-derived index for a batch projection; never retained across host mutations. */
export function createCanonicalOrcaSessionIdResolver(
  store: AgentSessionRecordReader
): (sessionId: OrcaSessionId) => OrcaSessionId {
  const clearedFrom = new Map<string, string>()
  for (const record of store.listRecords()) {
    const next = clearedInto(record)
    if (next) {
      clearedFrom.set(next, record.sessionId)
    }
  }
  const roots = new Map<string, OrcaSessionId>()
  return (orcaSessionId) => {
    let root: string = orcaSessionId
    const earlier = new Set([root])
    let prior = clearedFrom.get(root)
    while (prior && !earlier.has(prior)) {
      const known = roots.get(prior)
      if (known) {
        root = known
        prior = undefined
        break
      }
      earlier.add(prior)
      root = prior
      prior = clearedFrom.get(root)
    }
    if (!isOrcaSessionId(root)) {
      return orcaSessionId
    }
    // Corrupt cycles keep the existing bounded answer, without caching it as an acyclic root.
    if (!prior) {
      for (const sessionId of earlier) {
        roots.set(sessionId, root)
      }
    }
    return root
  }
}

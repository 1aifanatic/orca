import type { PersistedAgentSessionLease } from '../../shared/agent-session-legacy-handoff-lease'
import {
  editPersistedTestAgentSessionStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'

/** Rewrites one lease on disk as an older build left it; this build's types cannot express it. */
export async function writeOlderBuildLease(
  directory: string,
  sessionId: string,
  fields: Partial<PersistedAgentSessionLease>
): Promise<void> {
  await editPersistedTestAgentSessionStore(directory, (persisted) => {
    persisted.records[sessionId].lease = { ...persisted.records[sessionId].lease, ...fields }
  })
}

export async function readPersistedLease(
  directory: string,
  sessionId: string
): Promise<Record<string, unknown>> {
  return (await readPersistedTestAgentSessionStore(directory)).records[sessionId].lease
}

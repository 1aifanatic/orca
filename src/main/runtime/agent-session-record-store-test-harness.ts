/**
 * The one way tests open, seed and read back the durable agent-session record store, so a change
 * to where or how the store persists is made here rather than in every test that uses it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import type { PersistedAgentSessionRecord } from '../../shared/agent-session-legacy-handoff-lease'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath,
  type RetiredAgentSessionClaimKey
} from './agent-session-record-store-file'

const TEST_HOST_ID = 'local'

/** One committed state of the store, as tests seed it and read it back. */
export type PersistedTestAgentSessionStore = {
  schemaVersion: number
  hostId: string
  records: Record<string, PersistedAgentSessionRecord>
  operations: Record<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  unusableRecords: Record<string, { reason: string; raw: unknown }>
  /** Absent until the store first records a chat tab. */
  sessionTabs?: { tabId: string; sessionId: string }[]
}

/** Opens, or reopens, the store kept in `directory`: what a fresh app process does at launch. */
export function openTestAgentSessionRecordStore(
  directory: string,
  options: { hostId?: string } = {}
): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: options.hostId ?? TEST_HOST_ID })
}

/** Leaves `records` behind as an earlier run of the app would have, before anything opens it. */
export async function seedTestAgentSessionRecordStore(
  directory: string,
  seed: { records: readonly PersistedAgentSessionRecord[] }
): Promise<void> {
  const persisted: PersistedTestAgentSessionStore = {
    schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
    hostId: TEST_HOST_ID,
    records: Object.fromEntries(seed.records.map((record) => [record.sessionId, record])),
    operations: {},
    retiredClaimKeys: [],
    unusableRecords: {}
  }
  await mkdir(directory, { recursive: true })
  await writeFile(agentSessionStorePath(directory), JSON.stringify(persisted), 'utf-8')
}

/** Leaves an empty store a newer build wrote: this build reads it but never writes it. */
export async function seedTestAgentSessionStoreFromNewerBuild(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    agentSessionStorePath(directory),
    JSON.stringify({ schemaVersion: 99, hostId: TEST_HOST_ID, records: {}, operations: {} })
  )
}

/** Everything the store has committed, as text: to assert a value never reached disk, or that an
 *  action wrote nothing by comparing two reads. */
export function readPersistedTestAgentSessionStoreText(directory: string): Promise<string> {
  return readFile(agentSessionStorePath(directory), 'utf-8')
}

export async function readPersistedTestAgentSessionStore(
  directory: string
): Promise<PersistedTestAgentSessionStore> {
  return JSON.parse(await readPersistedTestAgentSessionStoreText(directory))
}

/** Changes the committed state behind the store's back, as an older build or a damaged disk would. */
export async function editPersistedTestAgentSessionStore(
  directory: string,
  edit: (persisted: PersistedTestAgentSessionStore) => void
): Promise<void> {
  const persisted = await readPersistedTestAgentSessionStore(directory)
  edit(persisted)
  await writeFile(agentSessionStorePath(directory), JSON.stringify(persisted))
}

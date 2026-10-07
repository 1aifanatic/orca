import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { hasPersistedLaunchObligation } from './agent-launch-persisted-obligations'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { hasPersistedStructuredAgentSessionStore } from './structured-agent-session-runtime'

const REF = { callerKey: 'trusted-local:desktop', operationId: 'op-1' }

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-launch-obligations-'))
})
afterEach(async () => {
  closeTestJournalHostDatabase(directory)
  await rm(directory, { recursive: true, force: true })
})

function launchRow(promptDelivery?: AgentSessionOperationRow['promptDelivery']) {
  const row: AgentSessionOperationRow = {
    ...REF,
    fingerprint: 'fp',
    operationTimestamp: 1,
    recordedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    outcome: { status: 'succeeded', sessionId: '', launch: { stub: true } },
    ...(promptDelivery ? { promptDelivery } : {})
  }
  return row
}

/** Leaves launch records behind, and no chat, as a profile that only launched terminal agents. */
async function leaveLaunchRecords(row: AgentSessionOperationRow): Promise<void> {
  await openTestAgentSessionRecordStore(directory)
  await editPersistedTestAgentSessionStore(directory, (persisted) => {
    persisted.operations = { [agentSessionOperationKey(REF.callerKey, REF.operationId)]: row }
  })
  closeTestJournalHostDatabase(directory)
}

describe('whether a restarted host owes a launch its prompt, read before opening the store', () => {
  it('finds an owed prompt in a profile that only ever launched terminal agents', async () => {
    await leaveLaunchRecords(
      launchRow({ state: 'owed', text: 'fix it', agent: 'claude', deadline: 9_000, terminal: null })
    )
    expect(hasPersistedLaunchObligation(directory, 'promptDelivery')).toBe(true)
    // The chat-store check sees no chat, so it cannot answer for launches.
    expect(hasPersistedStructuredAgentSessionStore(directory)).toBe(false)
  })

  it('finds nothing once every prompt settled', async () => {
    await leaveLaunchRecords(launchRow())
    expect(hasPersistedLaunchObligation(directory, 'promptDelivery')).toBe(false)
  })

  it('skips an owed prompt whose record has expired, which nothing reads any more', async () => {
    const row = launchRow({
      state: 'owed',
      text: 'fix it',
      agent: 'claude',
      deadline: 9_000,
      terminal: null
    })
    row.expiresAt = 50_000
    await leaveLaunchRecords(row)
    expect(hasPersistedLaunchObligation(directory, 'promptDelivery', 49_999)).toBe(true)
    expect(hasPersistedLaunchObligation(directory, 'promptDelivery', 50_000)).toBe(false)
  })

  it('finds a recorded follow-up the window has not taken yet', async () => {
    const row = launchRow()
    row.launchFollowUp = { kind: 'review-notes-delivered', version: 1, payload: {} }
    await leaveLaunchRecords(row)
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp')).toBe(true)
    expect(hasPersistedLaunchObligation(directory, 'promptDelivery')).toBe(false)
  })

  it('never creates the database of a profile that has none', () => {
    expect(hasPersistedLaunchObligation(directory, 'promptDelivery')).toBe(false)
    expect(existsSync(journalDatabasePath(directory))).toBe(false)
  })
})

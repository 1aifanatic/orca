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

function launchRow(launchFollowUp?: AgentSessionOperationRow['launchFollowUp']) {
  const row: AgentSessionOperationRow = {
    ...REF,
    fingerprint: 'fp',
    operationTimestamp: 1,
    recordedAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
    outcome: { status: 'succeeded', sessionId: '', launch: { stub: true } },
    ...(launchFollowUp ? { launchFollowUp } : {})
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

const FOLLOW_UP = { kind: 'review-notes-delivered', version: 1, payload: {} }

describe('whether launch records have a follow-up left for the window', () => {
  it('finds a follow-up in a profile that only ever launched terminal agents', async () => {
    await leaveLaunchRecords(launchRow(FOLLOW_UP))
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp')).toBe(true)
    expect(hasPersistedStructuredAgentSessionStore(directory)).toBe(false)
  })

  it('finds nothing once the window took every follow-up', async () => {
    await leaveLaunchRecords(launchRow())
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp')).toBe(false)
  })

  it('skips a follow-up whose row has expired', async () => {
    const row = launchRow(FOLLOW_UP)
    row.expiresAt = 50_000
    await leaveLaunchRecords(row)
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp', 49_999)).toBe(true)
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp', 50_000)).toBe(false)
  })

  it('ignores an old owed prompt without a follow-up', async () => {
    await leaveLaunchRecords(
      Object.assign(launchRow(), {
        promptDelivery: {
          state: 'owed',
          text: 'fix it',
          agent: 'claude',
          deadline: 9_000,
          terminal: null
        }
      })
    )
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp')).toBe(false)
  })

  it('never creates the database of a profile that has none', () => {
    expect(hasPersistedLaunchObligation(directory, 'launchFollowUp')).toBe(false)
    expect(existsSync(journalDatabasePath(directory))).toBe(false)
  })
})

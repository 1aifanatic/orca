// After a crash, a chat's status is listed from what was saved, without opening its history. A
// chat the crash cut mid-turn is the one exception: startup opens it, so its journal settles at
// the restart boundary, and what the list said agrees with what the open wrote.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { SavedStructuredSessionStatus } from '../../../shared/structured-agent-session-saved-status'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_LOCATION as LOCATION,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const PROVIDER_SESSION = 'provider-session-saved-1'
const FENCE = 13
const STARTED_AT = 1_800_000_000_000
const RELAUNCHED_AT = STARTED_AT + 60 * 60 * 1000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

const NEVER_WRITTEN = 'session-never-written-2'

function crashedRecord(sessionId = SESSION): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId,
    location: LOCATION,
    provider: 'claude',
    providerHandleChain: [
      {
        linkId: 'link-13',
        handle: claudeProviderHandle(PROVIDER_SESSION, null),
        origin: 'created',
        mintedAtFence: FENCE,
        observedAt: STARTED_AT
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    lease: {
      sessionId,
      runtimeKind: 'native',
      runtimeFence: FENCE,
      handoffStage: null,
      provenHandleLinkId: 'link-13',
      ownerProcess: {
        hostId: 'local',
        pid: 12_546,
        processStartTimeMs: STARTED_AT,
        spawnToken: 'spawn-crashed'
      },
      reservedSpawnToken: 'spawn-crashed',
      leaseDeadlineAt: STARTED_AT + 30_000,
      lastRenewedAt: STARTED_AT,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

/** A turn the crash left running, under the owner the lease names. */
async function seedRunningTurn(): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: claudeProviderHandle(PROVIDER_SESSION, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => STARTED_AT
  })
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: '0'.repeat(64),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run the loop' }] },
    fence: FENCE
  })
  const identity = { provider: 'claude' as const, sessionId: PROVIDER_SESSION, uuid: 'uuid-turn' }
  await journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: STARTED_AT },
    { fence: FENCE, turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(identity) } }
  )
  await journal.close()
}

function savedAs(status: AgentSessionStatusSummary['status']): SavedStructuredSessionStatus {
  return {
    summary: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      agent: 'claude',
      status,
      latestPrompt: 'what the list showed before the crash',
      updatedAt: STARTED_AT
    },
    turnFence: FENCE
  }
}

function sinkWith(saved: SavedStructuredSessionStatus[]) {
  return {
    publish: vi.fn<(summary: AgentSessionStatusSummary, subject: unknown) => void>(),
    forget: vi.fn(),
    readChildWork: vi.fn(() => []),
    saveStatus: vi.fn(),
    dropSavedStatus: vi.fn(),
    readSavedStatuses: () => saved
  }
}

function openHost(
  sink: ReturnType<typeof sinkWith>,
  probe: AgentSessionOwnerProbe = { outcome: 'pid-absent' }
) {
  const onSessionStatusChanged = vi.fn()
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    probeOwner: async () => probe,
    now: () => RELAUNCHED_AT,
    statusSink: sink,
    onSessionStatusChanged
  })
  return { onSessionStatusChanged }
}

/** What startup does: the lease check, then saved statuses, then the tab list. */
async function startUp(listed: string[] = [SESSION]): Promise<void> {
  await host.reconcileRestartLeases()
  await host.restoreSavedStatuses(listed)
}

const published = (sink: ReturnType<typeof sinkWith>) =>
  sink.publish.mock.calls.map(([summary]) => summary)

async function turnState(): Promise<string | undefined> {
  return (await host.journalSnapshot(SESSION)).items
    .map((item) => readAgentJournalTurn(item.body))
    .find(Boolean)?.state
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-saved-status-startup-'))
  await seedTestAgentSessionRecordStore(root, {
    records: [crashedRecord(), crashedRecord(NEVER_WRITTEN)]
  })
  store = await openTestAgentSessionRecordStore(root)
  await seedRunningTurn()
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a chat a crash cut mid-turn', () => {
  it.each(['working', 'attention'] as const)(
    'saved %s, reads Interrupted at once, and its startup open writes the same verdict',
    async (status) => {
      const sink = sinkWith([savedAs(status)])
      openHost(sink)

      await startUp()

      const [shown, settled] = published(sink)
      expect(shown).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
      expect(host.hasSession(SESSION)).toBe(true)
      expect(await turnState()).toBe('interrupted')
      // The open's own publish replaces the saved one, and agrees with it.
      expect(settled).toMatchObject({
        status: 'idle',
        turnOutcome: 'interruption',
        latestPrompt: 'run the loop'
      })
      expect(host.readStatusSummary(SESSION)).toEqual(settled)
    }
  )

  it("reads Couldn't confirm when its agent may still be running, as its open does", async () => {
    // An owner proven alive that this platform does not stop: released with no proof of death.
    const sink = sinkWith([savedAs('working')])
    openHost(sink, { outcome: 'identity-matched', matchedOn: ['spawn-token'] })
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    await startUp()

    expect(published(sink)[0]).toMatchObject({ status: 'idle', turnOutcome: 'unconfirmed' })
    expect(await turnState()).toBe('unverifiable')
    expect(host.readStatusSummary(SESSION)).toMatchObject({
      status: 'idle',
      turnOutcome: 'unconfirmed'
    })
  })

  it('is settled, closed and forgotten when no tab lists it', async () => {
    const sink = sinkWith([savedAs('working')])
    openHost(sink)

    await startUp([])

    expect(host.hasSession(SESSION)).toBe(false)
    expect(sink.dropSavedStatus).toHaveBeenCalledWith(SESSION)
    expect(await turnState()).toBe('interrupted')
  })

  it('still lists, settled, when its history cannot open', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    updateTestJournalRowJson(openTestJournalHostDatabase(root).db, SESSION, 1, '}{')
    const sink = sinkWith([savedAs('working')])
    openHost(sink)

    await expect(startUp()).resolves.toBeUndefined()

    expect(host.hasSession(SESSION)).toBe(false)
    expect(published(sink)).toEqual([
      expect.objectContaining({ status: 'idle', turnOutcome: 'interruption' })
    ])
    expect(host.listSessionTabs([SESSION])).toEqual([
      { sessionId: SESSION, workspaceId: LOCATION.workspaceId, agent: 'claude' }
    ])
  })
})

describe('a chat that was idle at the restart', () => {
  it('lists with its saved status, opens nothing and re-drives nothing', async () => {
    const sink = sinkWith([{ summary: { ...savedAs('idle').summary, turnOutcome: 'success' } }])
    const { onSessionStatusChanged } = openHost(sink)
    const status: unknown[] = []
    host.subscribeStatus({ id: 'list', emit: (event) => status.push(event) })

    await startUp()

    expect(host.hasSession(SESSION)).toBe(false)
    expect(published(sink)).toEqual([
      expect.objectContaining({ status: 'idle', turnOutcome: 'success' })
    ])
    expect(status).toContainEqual({
      type: 'status',
      session: expect.objectContaining({ sessionId: SESSION, turnOutcome: 'success' })
    })
    expect(host.listSessionTabs([SESSION])).toHaveLength(1)
    // Mail, naming and first-turn renames listen here; a saved status is not a journal edge.
    expect(onSessionStatusChanged).not.toHaveBeenCalled()
  })

  it('keeps the live status of a chat something opened before startup restored it', async () => {
    const sink = sinkWith([{ summary: { ...savedAs('idle').summary, turnOutcome: 'success' } }])
    openHost(sink)
    await host.journalSnapshot(SESSION)

    await startUp()

    expect(host.readStatusSummary(SESSION)).toMatchObject({ latestPrompt: 'run the loop' })
  })

  it('lists only chats with a history, so one never written founds none', async () => {
    openHost(sinkWith([]))

    await startUp([SESSION, NEVER_WRITTEN])

    expect(host.listSessionTabs([SESSION, NEVER_WRITTEN, SESSION])).toEqual([
      { sessionId: SESSION, workspaceId: LOCATION.workspaceId, agent: 'claude' }
    ])
    expect(host.hasSession(NEVER_WRITTEN)).toBe(false)
  })

  it('is replaced by its own publish once something opens it', async () => {
    const sink = sinkWith([{ summary: { ...savedAs('idle').summary, turnOutcome: 'success' } }])
    openHost(sink, { outcome: 'pid-absent' })
    await startUp()

    await host.journalSnapshot(SESSION)

    expect(host.readStatusSummary(SESSION)).toMatchObject({ latestPrompt: 'run the loop' })
    expect(published(sink).at(-1)).toMatchObject({ latestPrompt: 'run the loop' })
  })
})

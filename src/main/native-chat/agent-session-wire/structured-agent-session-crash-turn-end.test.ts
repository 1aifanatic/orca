// Where a turn a crash cut short ends, when the provider wrote nothing while it worked.
//
// Claude reports a Bash call once when it starts and again only when it finishes, so a command
// that runs for half a minute leaves one journal row at its start. The lease renewal the host
// wrote every ten seconds is what saw the child working after that row.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentTurnTimings
} from '../../../shared/structured-agent-session-turn-timing'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AGENT_SESSION_STORE_FILE_NAME } from '../../runtime/agent-session-record-store-file'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import {
  AgentSessionAcquisitionExitUnprovenError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import {
  hostTestAttachParams,
  HOST_TEST_LOCATION as LOCATION,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

const PROVIDER_SESSION = 'provider-session-alpha-1'
/** The tool call's row: the last thing the provider wrote before the crash. */
const TOOL_STARTED_AT = 1_800_000_000_000
/** The last renewal before the crash, while the command was still running. */
const LAST_RENEWED_AT = TOOL_STARTED_AT + 25_000
/** Orca comes back an hour later. */
const RELAUNCHED_AT = TOOL_STARTED_AT + 60 * 60 * 1000

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost

function crashedClaudeRecord(): AgentSessionRecord {
  const linkId = 'claude-13-link'
  return {
    schemaVersion: 2,
    sessionId: SESSION,
    location: LOCATION,
    provider: 'claude',
    providerHandleChain: [
      {
        linkId,
        handle: { provider: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null },
        origin: 'created',
        mintedAtFence: 13,
        observedAt: TOOL_STARTED_AT - 60_000
      }
    ],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
    createdAt: TOOL_STARTED_AT - 60_000,
    updatedAt: LAST_RENEWED_AT,
    lease: {
      sessionId: SESSION,
      runtimeKind: 'native',
      runtimeFence: 13,
      handoffStage: null,
      provenHandleLinkId: linkId,
      ownerProcess: {
        hostId: 'local',
        pid: 12_546,
        processStartTimeMs: TOOL_STARTED_AT - 60_000,
        spawnToken: 'spawn-crashed'
      },
      reservedSpawnToken: 'spawn-crashed',
      leaseDeadlineAt: LAST_RENEWED_AT + 30_000,
      lastRenewedAt: LAST_RENEWED_AT,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    }
  }
}

async function seedCrashedStore(): Promise<void> {
  const directory = join(root, 'store')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, AGENT_SESSION_STORE_FILE_NAME),
    JSON.stringify({
      schemaVersion: 2,
      hostId: 'local',
      records: { [SESSION]: crashedClaudeRecord() },
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {}
    }),
    'utf-8'
  )
  store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

/** A running turn whose only row after its start is a Bash call that never reported back, for a
 *  send the provider never acknowledged: the reopen settles it at the fence after the crash. */
async function seedClaudeToolTurn(): Promise<void> {
  let now = TOOL_STARTED_AT - 2_000
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null }
    },
    journalDir: journalDirectoryFor(root, {
      workspaceId: LOCATION.workspaceId,
      sessionId: SESSION
    }),
    now: () => now
  })
  await journal.appendSubmission({
    clientMessageId: 'send-1',
    payloadFingerprint: '0'.repeat(64),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'run the loop' }] },
    fence: 13
  })
  await journal.appendItem(
    { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'uuid-turn' },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: now },
    { fence: 13 }
  )
  now = TOOL_STARTED_AT
  await journal.appendItem(
    { provider: 'claude', sessionId: PROVIDER_SESSION, uuid: 'uuid-bash' },
    {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'for i in $(seq 90); do sleep 1; done' },
      state: 'running'
    },
    { fence: 13 }
  )
  await journal.close()
}

function openHost(overrides: Partial<StructuredAgentSessionHostDeps>): void {
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-new',
    now: () => RELAUNCHED_AT,
    ...overrides
  })
}

/** What a client reads over the wire. */
async function settledTurn() {
  return (await host.journalSnapshot(SESSION)).items
    .map((item) => readAgentJournalTurn(item.body))
    .find(Boolean)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-crash-turn-end-'))
  await seedCrashedStore()
  await seedClaudeToolTurn()
})

afterEach(async () => {
  await host?.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('a turn a crash cut short mid-tool', () => {
  it('ends at the last renewal, not at the tool call the provider last reported', async () => {
    openHost({ probeOwner: async () => ({ outcome: 'pid-absent' }) })

    await host.restoreReadableSessions()

    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'pid-absent',
      observedAt: RELAUNCHED_AT,
      lastProvenAliveAt: LAST_RENEWED_AT
    })
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
    // "Worked for 27s", where the tool call's row alone reads 2s.
    const [timing] = selectStructuredAgentTurnTimings(
      (await host.journalSnapshot(SESSION)).items
    ).values()
    expect(completedStructuredAgentTurnSeconds(timing)).toBe(27)
  })

  it('ends at the pre-crash renewal when the child outlived Orca and recovery stopped it', async () => {
    // The orphan is alive at relaunch, but its output went nowhere: none of that is work shown.
    let alive = true
    const probeOwner = async (): Promise<AgentSessionOwnerProbe> =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    openHost({ probeOwner, stopOwnerProcess })

    await host.restoreReadableSessions()

    expect(stopOwnerProcess).toHaveBeenCalledOnce()
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'pid-absent',
      lastProvenAliveAt: LAST_RENEWED_AT
    })
    expect(await settledTurn()).toMatchObject({
      state: 'interrupted',
      completedAt: LAST_RENEWED_AT
    })
  })
})

/** A relaunched host whose first start after the crash, at fence 15, fails with `failure`; every
 *  later start succeeds. The crashed owner, and any child left behind, probe gone. */
async function hostWithFailingFirstStart(failure: Error) {
  let now = RELAUNCHED_AT
  const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(
    async ({ fence, spawnToken, onSpawned }) => {
      const process = { hostId: 'local', pid: 7_000 + fence, processStartTimeMs: now, spawnToken }
      await onSpawned?.(process)
      if (fence === 15) {
        throw failure
      }
      return {
        process,
        link: {
          linkId: `claude-${fence}-link`,
          handle: { provider: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null },
          origin: 'resumed',
          mintedAtFence: fence,
          observedAt: now
        }
      }
    }
  )
  openHost({
    adapter: {
      acquire,
      releaseAcquisition: async () => true,
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    now: () => now
  })
  await host.reconcileRestartLeases()
  return {
    attach: (fence: number) =>
      host.attach(
        { callerKey: 'client-1' },
        hostTestAttachParams(fence, {
          provider: 'claude',
          agent: 'claude',
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
          providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION, leafUuid: null }
        })
      ),
    advance: (ms: number) => {
      now += ms
    }
  }
}

/** The turn as the crashed owner left it, with no end: nothing proves when that owner stopped. */
const UNVERIFIABLE_TURN = {
  turnId: 'turn-1',
  state: 'unverifiable',
  startedAt: TOOL_STARTED_AT - 2_000
}

// The relaunch proved the fence-13 owner gone, but a start reserving fence 15 clears that proof
// before the turn is settled; what the record holds afterwards is about the start's own child.
describe('a turn a newer start could not settle before it failed', () => {
  it('is not judged by the death of the child it left for recovery', async () => {
    const { attach, advance } = await hostWithFailingFirstStart(
      new AgentSessionAcquisitionExitUnprovenError(new Error('hung'))
    )

    await attach(14).catch(() => undefined)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeFence: 15,
      handoffStage: 'recovering',
      lastRenewedAt: RELAUNCHED_AT
    })
    advance(60_000)
    // Recovery records that child's death, then the client retries at the fence it was told.
    await expect(attach(15)).resolves.toMatchObject({ refusal: { currentFence: 16 } })
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      ownerFence: 15,
      lastProvenAliveAt: RELAUNCHED_AT
    })
    await expect(attach(16)).resolves.toMatchObject({ ok: true })

    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)
  })

  it('is not judged by the watched exit of a start that failed', async () => {
    const { attach, advance } = await hostWithFailingFirstStart(new Error('claude exited (code 1)'))

    await expect(attach(14)).resolves.toMatchObject({ ok: false })
    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
      kind: 'exit-observed',
      ownerFence: 15,
      observedAt: RELAUNCHED_AT
    })
    advance(60_000)
    await expect(attach(16)).resolves.toMatchObject({ ok: true })

    // Main ended it at the failed start, an hour after the crash, with the start's reason.
    expect(await settledTurn()).toEqual(UNVERIFIABLE_TURN)
  })
})

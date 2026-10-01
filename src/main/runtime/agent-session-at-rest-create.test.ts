// A chat's create founds its record at rest, and is the only thing that does: adoption, the tab
// it reserves, and every refusal of a record that cannot be founded are decided here.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  commitAgentSessionAtRestCreate,
  type AgentSessionAtRestCreateRequest
} from './agent-session-at-rest-create'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
const SESSION = 'session-creating'
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const ACCOUNT_HOME = { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/dev/.claude' }

let operations = 0
function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

function createRequest(
  overrides: Partial<AgentSessionAtRestCreateRequest> = {}
): AgentSessionAtRestCreateRequest {
  return {
    sessionId: SESSION,
    location: LOCATION,
    provider: 'claude',
    accountHome: ACCOUNT_HOME,
    claimKeyId: 'key-1',
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-create' },
    now: NOW,
    ...overrides
  }
}

function storeState(records: readonly AgentSessionRecord[] = []): AgentSessionStoreState {
  return {
    schemaVersion: 2,
    hostId: 'local',
    records: new Map(records.map((record) => [record.sessionId, record])),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
}

function adoptedLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'claude-1-provider-session-alpha-1-empty',
    handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null },
    origin: 'adopted',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

/** Another chat whose agent already ran the conversation `adoptedLink` names, on another leaf. */
function holderOfAdoptedConversation(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-holder' })),
    providerHandleChain: [
      adoptedLink({
        linkId: 'claude-1-provider-session-alpha-1-leaf',
        handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: 'leaf-1' },
        origin: 'created'
      })
    ]
  }
}

describe('a create at rest', () => {
  it('founds a released record at fence 1 with an empty chain, so its first start is fresh', () => {
    const state = storeState()
    const { record, replayed } = commitAgentSessionAtRestCreate(state, createRequest())

    expect(replayed).toBe(false)
    expect(record.providerHandleChain).toEqual([])
    expect(record.lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: null
    })
    expect(state.records.get(SESSION)).toEqual(record)
  })

  it('replays the record its own operation founded, and writes nothing more', () => {
    const state = storeState()
    const request = createRequest()
    const first = commitAgentSessionAtRestCreate(state, request)

    const replay = commitAgentSessionAtRestCreate(state, { ...request, now: NOW + 1 })

    expect(replay).toMatchObject({ replayed: true, record: first.record })
    expect(state.operations.size).toBe(1)
  })

  it('refuses a second create of a session that exists', () => {
    const state = storeState()
    commitAgentSessionAtRestCreate(state, createRequest())

    expect(() => commitAgentSessionAtRestCreate(state, createRequest())).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'agent_session_conflict',
          details: { reason: 'sessionExists' }
        })
      })
    )
  })

  it('refuses a session whose record this build cannot read, as reconciling', () => {
    const state = storeState()
    state.unreadableRecords.set(SESSION, { reason: 'invalid', raw: {} })

    expect(() => commitAgentSessionAtRestCreate(state, createRequest())).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'execution_owner_reconciling',
          details: { reason: 'recordUnreadable' }
        })
      })
    )
    expect(state.records.size).toBe(0)
  })

  it('refuses launch args or options it cannot store, before founding anything', () => {
    const state = storeState()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a malformed payload the store must refuse.
    const launchArgs = [42] as unknown as string[]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a malformed payload the store must refuse.
    const options = { model: 7 } as unknown as Record<string, string>

    expect(() => commitAgentSessionAtRestCreate(state, createRequest({ launchArgs }))).toThrow(
      'agent_session_launch_args_invalid'
    )
    expect(() => commitAgentSessionAtRestCreate(state, createRequest({ options }))).toThrow(
      'agent_session_options_invalid'
    )
    expect(state.records.size).toBe(0)
  })
})

describe('an adopting create at rest', () => {
  it('seeds the chain with the adopted link alone, at the record fence its first start moves', () => {
    const link = adoptedLink()
    const { record } = commitAgentSessionAtRestCreate(
      storeState(),
      createRequest({ adoptedHandleLink: link })
    )

    expect(record.providerHandleChain).toEqual([link])
    expect(record.lease.runtimeFence).toBe(link.mintedAtFence)
  })

  it('refuses a conversation another record already holds, by its root', () => {
    // The held link names a leaf; the adoption names none. Keying on the exact handle would let two
    // writers onto one conversation on different branches.
    const state = storeState([holderOfAdoptedConversation()])

    expect(() =>
      commitAgentSessionAtRestCreate(state, createRequest({ adoptedHandleLink: adoptedLink() }))
    ).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'agent_session_conflict',
          details: { reason: 'conversationHeldElsewhere' }
        })
      })
    )
    expect(state.records.has(SESSION)).toBe(false)
  })

  it('admits a conversation no record holds', () => {
    const state = storeState([holderOfAdoptedConversation()])
    const other = adoptedLink({
      handle: { provider: 'claude', sessionId: 'provider-session-other', leafUuid: null }
    })

    expect(
      commitAgentSessionAtRestCreate(state, createRequest({ adoptedHandleLink: other })).record
        .providerHandleChain
    ).toEqual([other])
  })
})

describe('the tab a create reserves', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-at-rest-create-tab-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('takes no tab at create, then answers a replay naming another tab with the one it was given', async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    const request = createRequest({ surfaceTabId: 'chat-tab-1' })
    await store.createAtRest(request)
    // Publishing the tab takes the id, so a create that never gets there leaves nothing behind.
    expect(store.getSessionTabId(SESSION)).toBeNull()

    await store.setSessionTabVisibility(SESSION, true, 'chat-tab-1')
    expect(await store.createAtRest({ ...request, surfaceTabId: 'chat-tab-2' })).toMatchObject({
      replayed: true
    })
    expect(store.getSessionTabId(SESSION)).toBe('chat-tab-1')
  })

  it("refuses a tab id another session's tab holds, and a malformed one", async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    await store.createAtRest(createRequest({ surfaceTabId: 'chat-tab-1' }))
    await store.setSessionTabVisibility(SESSION, true, 'chat-tab-1')

    await expect(
      store.createAtRest(createRequest({ sessionId: 'session-other', surfaceTabId: 'chat-tab-1' }))
    ).rejects.toMatchObject({ refusal: { code: 'agent_session_conflict' } })
    await expect(
      store.createAtRest(createRequest({ sessionId: 'session-other', surfaceTabId: '' }))
    ).rejects.toMatchObject({ refusal: { code: 'agent_session_operation_invalid' } })
    expect(store.getRecord('session-other')).toBeNull()
  })
})

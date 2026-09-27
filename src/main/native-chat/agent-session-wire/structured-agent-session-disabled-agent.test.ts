// Attach is where every new chat starts a provider (create, ensure, /clear), so it refuses a new
// session for an agent the user turned off; a session that already has a record is left alone.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const DISABLED_MESSAGE = 'Agent codex is disabled. Choose an enabled agent.'
const caller = { callerKey: 'desktop' }
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: ReturnType<typeof vi.fn<StructuredAgentSessionAdapter['acquire']>>
const disabled = new Set<string>()

beforeEach(async () => {
  resetHostTestOperationIds()
  disabled.clear()
  directory = await mkdtemp(join(tmpdir(), 'orca-disabled-agent-attach-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>(async (input) => ({
    process: {
      hostId: 'local',
      pid: 4000 + acquire.mock.calls.length,
      processStartTimeMs: HOST_TEST_NOW,
      spawnToken: input.spawnToken
    },
    link: {
      linkId: `link-${acquire.mock.calls.length}`,
      mintedAtFence: input.fence,
      observedAt: HOST_TEST_NOW,
      origin: 'created' as const,
      handle: {
        provider: 'codex' as const,
        threadId: `00000000-0000-4000-8000-${String(acquire.mock.calls.length).padStart(12, '0')}`
      }
    }
  }))
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      supportsLocation: (location) => location.executionHostId === 'local',
      acquire,
      dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: async () => {},
      setOption: async () => {},
      releaseAcquisition: async () => true,
      closeSession: async () => true,
      readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
    },
    journalRoot: directory,
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    isAgentEnabled: (agent) => !disabled.has(agent)
  })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

describe('attaching for an agent the user turned off', () => {
  it('refuses a new session with the reason, before anything is reserved or spawned', async () => {
    disabled.add('codex')
    const params = hostTestAttachParams(null)

    const result = await host.attach(caller, params)

    expect(result).toEqual({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported', message: DISABLED_MESSAGE }
    })
    expect(store.getRecord(HOST_TEST_SESSION)).toBeNull()
    expect(store.getOperationRow(caller.callerKey, params.envelope.clientOperationId)).toBeNull()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('refuses the new session a /clear would start, leaving the chat usable', async () => {
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    await host.setSessionTabVisibility(HOST_TEST_SESSION, true)
    disabled.add('codex')

    const result = await host.conversationCommand(caller, {
      command: 'clear',
      envelope: {
        sessionId: HOST_TEST_SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.conversationCommand',
          sessionId: HOST_TEST_SESSION,
          fields: { command: 'clear' }
        })
      }
    })

    expect(result).toMatchObject({
      ok: true,
      value: { state: 'completed', replacementSessionId: undefined, error: DISABLED_MESSAGE }
    })
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(store.listVisibleSessionIds()).toEqual([HOST_TEST_SESSION])
  })

  it('answers a committed create from its record once the agent is turned off', async () => {
    const params = hostTestAttachParams(null)
    expect(await host.attach(caller, params)).toMatchObject({ ok: true, replayed: false })
    disabled.add('codex')

    expect(await host.attach(caller, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { sessionId: HOST_TEST_SESSION }
    })
    expect(acquire).toHaveBeenCalledTimes(1)
  })

  it('leaves an enabled agent alone', async () => {
    disabled.add('claude')
    expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
    expect(acquire).toHaveBeenCalledTimes(1)
  })
})

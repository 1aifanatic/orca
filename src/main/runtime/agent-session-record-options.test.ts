import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { nativeSessionOptionsFromReport } from '../native-chat/agent-session-wire/structured-agent-session-option-restoration'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

const NOW = 1_800_000_000_000
const SESSION = 'session-options'
let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-options-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('drops provider-rejected persisted options from what a started child reports', () => {
  expect(
    nativeSessionOptionsFromReport({
      reported: { model: 'provider-model' },
      restoreSkipped: ['permissionMode'],
      priorOptions: { permissionMode: 'retired-mode', other: 'keep' }
    })
  ).toEqual({ model: 'provider-model', other: 'keep' })
})

it('makes the process the owner before its provider answers with a handle, and records it after', async () => {
  const store = await openTestAgentSessionRecordStore(directory)
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/accounts/codex' },
    expectedFence: null,
    spawnToken: 'spawn-options',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'new session' },
    operation: {
      callerKey: 'client-1',
      operationId: '1800000000000-00000000000000000000000000000000',
      fingerprint: 'options-create'
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW - 1,
      spawnToken: 'spawn-options'
    },
    now: NOW
  })
  await store.proveOwner({ sessionId: SESSION, fence, now: NOW })
  await store.replaceSessionOptions({
    sessionId: SESSION,
    fence,
    options: { model: 'gpt-tui' },
    now: NOW
  })
  // A crash here leaves a record the next run reads back: live, its handle still owed.
  const starting = (await openTestAgentSessionRecordStore(directory)).getRecord(SESSION)
  expect(starting?.lease).toMatchObject({ claimStatus: 'live', provenHandleLinkId: null })
  expect(starting?.providerHandleChain).toEqual([])
  expect(starting?.options).toEqual({ model: 'gpt-tui' })

  await store.transitionHandoff(SESSION, (record) =>
    recordAgentSessionProviderHandle({
      record,
      fence,
      link: {
        linkId: 'codex-options-1',
        handle: codexProviderHandle('thread-options'),
        origin: 'created',
        mintedAtFence: fence,
        observedAt: NOW
      },
      now: NOW
    })
  )
  const started = (await openTestAgentSessionRecordStore(directory)).getRecord(SESSION)
  expect(started?.lease.provenHandleLinkId).toBe('codex-options-1')
  expect(started?.providerHandleChain.map((link) => link.linkId)).toEqual(['codex-options-1'])
})

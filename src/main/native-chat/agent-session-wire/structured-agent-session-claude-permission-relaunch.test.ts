// Full access on a Claude chat whose child was launched without the bypass flag, on the shipping
// adapter and host: the CLI refuses the live switch, so the pick is kept as the chat's mode and the
// next send starts a child launched with the flag, resuming the same conversation.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { storedAgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import { ClaudeStructuredSessionAdapter } from '../../claude/claude-structured-session-adapter'
import {
  fakeClaude,
  PROVIDER_SESSION_ID
} from '../../claude/claude-structured-session-test-support'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let host: StructuredAgentSessionHost
let adapter: ClaudeStructuredSessionAdapter
let store: AgentSessionRecordStore
let claude: ReturnType<typeof fakeClaude>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-permission-relaunch-'))
  resetHostTestOperationIds()
  const log = recordingStructuredAgentSessionLogger()
  claude = fakeClaude({ replayUuid: null })
  const lifecycle: Promise<void>[] = []
  adapter = new ClaudeStructuredSessionAdapter({
    // As the real resolver: the chat's stored mode, else the setting (here, Ask).
    resolveLaunch: async () => {
      const record = store.getRecord(SESSION)
      const resumed = (record?.providerHandleChain.length ?? 0) > 0
      return {
        pathToClaudeCodeExecutable: 'claude',
        options: {},
        cwd: root,
        claudeConfigDir: join(root, 'claude-home'),
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumesTranscript: resumed,
        continuesChain: resumed,
        permissionMode: storedAgentChatPermissionMode('claude', record?.options) ?? 'ask'
      }
    },
    onEvent: (event) => {
      const mapped = structuredClaudeLifecycleEvent(event)
      if (mapped) {
        lifecycle.push(host.handleAdapterEvent(mapped))
      }
    },
    onDispatchSettledLate: (settlement) => void host.settleLateDispatch(settlement),
    persistHandle: async () => undefined,
    logger: log.logger,
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => NOW
  })
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexAgents(adapter),
    store,
    adapter: Object.assign(adapter, { supportsCreate: () => true }),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    logger: log.logger,
    idleSweep: { intervalMs: 3_600_000 },
    now: () => NOW
  })
  const params = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
    providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
  })
  expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
  await adapter.awaitStarted(SESSION)
  await Promise.all(lifecycle)
})

afterEach(async () => {
  await adapter.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function envelope(
  method: 'agentSession.send' | 'agentSession.setOption',
  fields: Parameters<typeof computeAgentSessionPayloadFingerprint>[0]['fields']
) {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function pick(value: string) {
  const fields = { key: 'permissionMode', value }
  return host.setOption(CALLER, { envelope: envelope('agentSession.setOption', fields), ...fields })
}

function permissionWrites(index: number): unknown[] {
  return (claude.connections[index]?.calls ?? []).flatMap((call) =>
    call.subtype === 'set_permission_mode' ? [call.params] : []
  )
}

it('keeps Full access as the chat mode and relaunches with the flag before the next send', async () => {
  expect(claude.connections).toHaveLength(1)

  expect(await pick('bypass')).toMatchObject({ ok: true })
  // No control request: the CLI refuses it on a child launched without the flag.
  expect(permissionWrites(0)).toEqual([])
  expect(store.getRecord(SESSION)?.options).toMatchObject({ permissionMode: 'bypass' })
  expect(claude.connections[0]?.closeCount).toBe(0)

  const body = hostTestMessage('now with full access')
  expect(
    await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).toMatchObject({ ok: true })

  await vi.waitFor(() => expect(claude.connections).toHaveLength(2), { timeout: 10_000 })
  expect(claude.connections[0]?.closeCount).toBeGreaterThan(0)
  await vi.waitFor(
    () =>
      expect(
        claude.connections[1]?.sent.some((message) =>
          JSON.stringify(message).includes('now with full access')
        )
      ).toBe(true),
    { timeout: 10_000 }
  )
  // The new child replays the chat's mode, which it can now take.
  expect(permissionWrites(1)).toEqual([{ mode: 'bypassPermissions' }])
  // The message went only to the child launched for it.
  expect(
    claude.connections[0]?.sent.some((message) =>
      JSON.stringify(message).includes('now with full access')
    )
  ).toBe(false)
})

it('applies any other mode live without a new child', async () => {
  expect(await pick('accept-edits')).toMatchObject({ ok: true })
  expect(permissionWrites(0)).toEqual([{ mode: 'acceptEdits' }])

  const body = hostTestMessage('edits only')
  await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  await vi.waitFor(
    () =>
      expect(
        claude.connections[0]?.sent.some((message) =>
          JSON.stringify(message).includes('edits only')
        )
      ).toBe(true),
    { timeout: 10_000 }
  )
  expect(claude.connections).toHaveLength(1)
})

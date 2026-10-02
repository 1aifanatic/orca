// A released desktop (accepted sends, no final-state reads) sending a chat's first message to this
// host. That client reads `pending` as delivered, and the message now starts its agent after the
// host accepts it, so the host holds its reply past the start, up to a cap, and answers a start
// still under way as `unknown`. Read with the released client's own outbox code: it keeps the
// message under the same id, resends only that id, and the host answers it from its ledger.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-registry'
import { createStructuredAgentSessionLogger } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-logger'
import { openTestJournalHostDatabase } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { AgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../../src/main/runtime/agent-session-record-store-test-harness'
import { ACCEPTED_SEND_CLIENT_HOLD_MS } from '../../../src/main/runtime/rpc/methods/structured-agent-session-send-compatibility'
import {
  AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef,
  type ReleaseCheckout
} from './release-checkout'
import {
  attachParams,
  createIntentParams,
  NOW,
  resetOperationIds,
  SESSION,
  THREAD
} from './structured-agent-session-surface-manifest'
import {
  loadAgentSessionWireBuild,
  WORKING_TREE,
  type AgentSessionWireBuild,
  type RpcReply
} from './versioned-agent-session-wire'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000

type OutboxEntry = { clientMessageId: string; state: string }
type ReleasedClient = {
  capabilities: string[]
  createEntry: (args: Record<string, unknown>) => OutboxEntry
  sendRequest: (entry: OutboxEntry, fence: number) => unknown
  dispose: (input: Record<string, unknown>) => { entries: OutboxEntry[] }
  reconcile: (entries: OutboxEntry[], submissions: unknown[]) => OutboxEntry[]
  admit: (entries: OutboxEntry[]) => { state: string }
}

let current: AgentSessionWireBuild
let released: ReleasedClient

async function releasedClient(checkout: ReleaseCheckout): Promise<ReleasedClient> {
  const [protocol, outbox, disposition] = await Promise.all([
    importReleaseCheckoutModule(checkout, '/src/shared/protocol-version.ts'),
    importReleaseCheckoutModule(checkout, '/src/shared/structured-agent-session-outbox.ts'),
    importReleaseCheckoutModule(
      checkout,
      '/src/shared/structured-agent-session-send-disposition.ts'
    )
  ])
  const listed = protocol.ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  if (!Array.isArray(listed)) {
    throw new Error('The baseline release lists no Electron remote client capabilities')
  }
  const members = {
    createEntry: outbox.createStructuredAgentSessionOutboxEntry,
    sendRequest: outbox.structuredAgentSessionSendRequest,
    dispose: disposition.disposeStructuredAgentSessionSendResult,
    reconcile: outbox.reconcileStructuredAgentSessionOutbox,
    admit: outbox.admitStructuredAgentSessionOutboxEntry
  }
  for (const [name, member] of Object.entries(members)) {
    if (typeof member !== 'function') {
      throw new Error(`The baseline release's client has no ${name}`)
    }
  }
  return {
    // What a released desktop advertises to a remote host, minus the capability this host keys
    // the hold on, so the pairing stays exercised once a release ships it. No release advertises
    // structured chats to a remote host yet (the host refuses them as clientCapabilityMissing),
    // so it is added: the desktop this hold is for is one that does, without final-state reads.
    capabilities: [
      ...listed.filter(
        (capability): capability is string =>
          typeof capability === 'string' &&
          capability !== AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY
      ),
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each member was just checked to be a function, and these are the shapes the release's own source declares for them.
    ...(members as unknown as Omit<ReleasedClient, 'capabilities'>)
  }
}

beforeAll(async () => {
  current = await loadAgentSessionWireBuild(WORKING_TREE)
  released = await releasedClient(await materializeReleaseCheckout(resolveBaselineReleaseRef()))
}, SUITE_TIMEOUT_MS)

describe("a released desktop's first message to a chat at rest", () => {
  let root: string
  let store: AgentSessionRecordStore
  let host: StructuredAgentSessionHost
  /** Holds the agent's start open: the start is under way until it opens. */
  let open: () => void

  /** The first start is refused for an account switch, which books another try in 15 s. */
  let switching = false

  function adapter(): StructuredAgentSessionAdapter {
    let gate = new Promise<void>((resolve) => (open = resolve))
    return {
      supportsCreate: () => true,
      acquire: async ({ fence }) => {
        if (switching) {
          switching = false
          throw new AgentSessionPreSpawnError(new Error('switching'), {
            reason: 'accountSwitchInProgress'
          })
        }
        await gate
        gate = Promise.resolve()
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
          },
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex', threadId: THREAD },
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        }
      },
      dispatch: async () => ({
        state: 'accepted',
        providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
      }),
      cancelTurn: async () => ({ cancelled: true }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    }
  }

  function runtime(): unknown {
    return {
      getRuntimeId: () => 'runtime-1',
      getClientSettings: () => ({ experimentalStructuredNativeChat: true }),
      ensureStructuredAgentSessionHost: async () => undefined,
      getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
      resolveStructuredAgentSessionCreateIntent: async () => {
        const {
          envelope: _envelope,
          providerHandle: _providerHandle,
          ...resolved
        } = attachParams(null)
        return resolved
      },
      publishStructuredAgentSessionTab: () => {}
    }
  }

  async function call(
    method: string,
    params: unknown,
    capabilities: readonly string[]
  ): Promise<RpcReply> {
    const replies: RpcReply[] = []
    await current
      .createDispatcher(runtime())
      .dispatchStreaming(
        { id: `request-${method}`, authToken: 'cross-version-token', method, params },
        (raw) => replies.push(JSON.parse(raw) as RpcReply),
        { clientKind: 'runtime', clientCapabilities: capabilities, clientId: 'paired-desktop' }
      )
    return replies[0]!
  }

  async function journalRows() {
    return (await host.journalSnapshot(SESSION)).submissions
  }

  beforeEach(async () => {
    switching = false
    resetOperationIds()
    root = await mkdtemp(join(tmpdir(), 'orca-cross-version-accepted-send-'))
    store = await openTestAgentSessionRecordStore(root)
    host = new StructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      store,
      adapter: adapter(),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-a',
      now: () => NOW
    })
    setStructuredAgentSessionHost(host)
  })

  afterEach(async () => {
    vi.useRealTimers()
    setStructuredAgentSessionHost(null)
    await rm(root, { recursive: true, force: true })
  })

  async function createdChat(): Promise<number> {
    const created = await call('agentSession.create', createIntentParams(), [
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
    const result = created.result
    if (!result || typeof result !== 'object' || !('fence' in result)) {
      throw new Error(`create answered no fence: ${JSON.stringify(created)}`)
    }
    return Number(result.fence)
  }

  function firstMessage(hex: string): OutboxEntry {
    return released.createEntry({
      clientMessageId: `${NOW}-${hex.repeat(32)}`,
      sessionId: SESSION,
      text: 'review my notes',
      attachments: [],
      queuedAt: NOW
    })
  }

  it('is answered unknown at the cap while its start runs, and only ever resent under its own id', async () => {
    expect(released.capabilities).toContain(AGENT_SESSION_ACCEPTED_SEND_RUNTIME_CAPABILITY)
    const fence = await createdChat()
    const entry = released.createEntry({
      clientMessageId: `${NOW}-${'a'.repeat(32)}`,
      sessionId: SESSION,
      text: 'review my notes',
      attachments: [],
      queuedAt: NOW
    })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let reply: RpcReply | undefined
    void call('agentSession.send', released.sendRequest(entry, fence), released.capabilities).then(
      (answered) => (reply = answered)
    )
    await vi.advanceTimersByTimeAsync(ACCEPTED_SEND_CLIENT_HOLD_MS - 1)
    // The start is still under way: a `pending` now would read as delivered.
    expect(reply).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    expect(reply).toMatchObject({
      ok: true,
      result: {
        value: { clientMessageId: entry.clientMessageId, submission: { dispatchState: 'unknown' } }
      }
    })

    // The released client keeps it as unconfirmed under the same id, holding the queue: no new id.
    const disposed = released.dispose({
      entries: [{ ...entry, state: 'dispatching' }],
      entry: { ...entry, state: 'dispatching' },
      blockedClientMessageId: null,
      result: reply!.result,
      createOperationId: () => 'a-new-id-the-client-must-not-use'
    }).entries
    expect(disposed).toEqual([
      expect.objectContaining({ clientMessageId: entry.clientMessageId, state: 'unconfirmed' })
    ])
    expect(released.admit(disposed).state).toBe('blocked')
    // The journal's own row moves it back to waiting on the host, still under the same id.
    const waiting = released.reconcile(disposed, await journalRows())
    expect(waiting).toEqual([
      expect.objectContaining({ clientMessageId: entry.clientMessageId, state: 'dispatching' })
    ])

    // A resend (its probe or its Retry) reuses the id; the host answers it from its ledger.
    const resent = call(
      'agentSession.send',
      released.sendRequest(entry, fence),
      released.capabilities
    )
    open()
    expect(await resent).toMatchObject({
      ok: true,
      result: { value: { clientMessageId: entry.clientMessageId } }
    })
    await vi.waitFor(async () =>
      expect(await journalRows()).toEqual([
        expect.objectContaining({
          clientMessageId: entry.clientMessageId,
          dispatchState: 'accepted'
        })
      ])
    )
    expect(released.reconcile(waiting, await journalRows())).toEqual([])
  })

  it('is answered once its start hands it over, within the cap', async () => {
    const fence = await createdChat()
    const entry = firstMessage('b')

    const reply = call(
      'agentSession.send',
      released.sendRequest(entry, fence),
      released.capabilities
    )
    open()
    expect(await reply).toMatchObject({
      ok: true,
      result: { value: { submission: { handedOverAt: expect.any(Number) } } }
    })
  })

  it('waits out a start that failed and booked another try, rather than answer it pending', async () => {
    const fence = await createdChat()
    switching = true
    open()
    const entry = firstMessage('d')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let reply: RpcReply | undefined
    void call('agentSession.send', released.sendRequest(entry, fence), released.capabilities).then(
      (answered) => (reply = answered)
    )
    await vi.advanceTimersByTimeAsync(ACCEPTED_SEND_CLIENT_HOLD_MS - 1)
    expect(reply).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    expect(reply).toMatchObject({
      ok: true,
      result: { value: { submission: { dispatchState: 'unknown' } } }
    })
  })

  it('answers a current desktop at acceptance, while the start still runs', async () => {
    const fence = await createdChat()
    const entry = firstMessage('c')

    const reply = await call('agentSession.send', released.sendRequest(entry, fence), [
      ...released.capabilities,
      AGENT_SESSION_SEND_FINAL_STATE_RUNTIME_CAPABILITY
    ])
    expect(reply).toMatchObject({
      ok: true,
      result: { value: { submission: { dispatchState: 'pending' } } }
    })
    open()
  })
})

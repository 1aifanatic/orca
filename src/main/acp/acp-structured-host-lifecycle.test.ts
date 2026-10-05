// The ACP adapter behind the real host: the host's own order (a fresh sink per start, bound only
// once the start proved its owner; Close and Stop reaching a start from outside the session's
// queue), with a scripted Grok, the real record store and an on-disk journal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionStoredAgents } from '../../shared/agent-session-stored-agent'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { readAgentSessionFailureFact } from '../../shared/agent-session-failure'
import { withNativeChatCutTurnNotices } from '../../shared/native-chat-cut-turn-notice'
import { openTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  closeProviderTimelineRigs,
  messageText
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import {
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { AgentSessionRecoveryCapsule } from '../runtime/agent-session-recovery-capsule'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import {
  GROK,
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  waitFor
} from './acp-structured-adapter.test-support'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import type { AcpStructuredLaunch } from './acp-structured-launch-resolution'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

const attachParams = (fence: number | null = null) =>
  hostTestAttachParams(fence, {
    provider: 'grok',
    agent: 'grok',
    accountHome: { variable: 'GROK_HOME', path: '/grok' },
    providerHandle: undefined
  })

/** A launch that resumes the provider session once the chat has one. */
function launch(resume: () => boolean): () => Promise<AcpStructuredLaunch> {
  return async () => ({
    spec: GROK,
    command: '/fake/grok',
    args: [],
    cwd: '/workspace',
    env: {},
    fullAccess: false,
    resume: resume() ? { sessionId: PROVIDER_SESSION, replaceableKey: null } : null
  })
}

async function openHostRig(
  options: {
    script?: (agent: AcpScriptedAgent) => void
    initialize?: Record<string, unknown>
    deps?: Partial<AcpStructuredSessionAdapterDeps>
  } = {}
) {
  const state = hostTestState()
  const store = await openTestAgentSessionRecordStore(state.root, {
    agents: agentSessionStoredAgents([
      { agent: 'grok', handleTransport: 'acp', accountHomeVariable: 'GROK_HOME' }
    ])
  })
  let generation = 0
  // As the runtime wires it: every exit the adapter observes reaches the host.
  const hosted: { host: StructuredAgentSessionHost | null } = { host: null }
  const rig = await openAcpAdapterRig({
    ...options,
    deps: {
      onEvent: (event) => void hosted.host?.handleAdapterEvent(event),
      now: () => HOST_TEST_NOW,
      readProcessStartTime: async () => 1_700_000_000_000 + ++generation,
      mintGeneration: () => `generation-${generation}`,
      ...options.deps
    }
  })
  const host = new StructuredAgentSessionHost({
    agents: new StructuredAgentRegistry([
      { definition: acpStructuredAgentDefinition(GROK), adapter: rig.adapter }
    ]),
    logger: state.log.logger,
    store,
    adapter: rig.adapter,
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  hosted.host = host
  replaceHostTestState({ store, host })
  const fence = () => store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const messages = async () =>
    (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
      .filter((row) => row.body.kind === 'message')
      .map((row) => messageText(row.body))
  /** Orca's send of `hello` as `m1`, and Grok's reply `text`, ended or left running. */
  const exchange = async (text: string, end: boolean) => {
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    await journal.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
      fence: fence(),
      turnScope: { kind: 'thread' }
    })
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'm1',
      body: hello,
      fence: fence()
    })
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:m1', text))
    if (end) {
      rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    }
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
  }
  return { rig, host, store, fence, messages, exchange }
}

/** Grok's capabilities: it loads and resumes sessions. */
const RESUMES = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }

/** On every resume, Grok sends what its resume may carry: the saved `reply` marked as replay, and a
 *  task the dead process left running, ended by the restart. */
function resumes(reply: string, count: { resumes: number }) {
  return (agent: AcpScriptedAgent) =>
    agent.on('session/resume', (frame) => {
      count.resumes += 1
      agent.notify('session/update', replyChunk('prompt:m1', reply, { isReplay: true }))
      agent.notify('x.ai/task_completed', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'task_completed',
          task_snapshot: { task_id: 'task-orphan', command: 'sleep 600', signal: 'session_restart' }
        }
      })
      agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
    })
}

describe('resuming a Grok chat through the host', () => {
  it('resumes a chat the journal holds and writes its exchange once', async () => {
    const count = { resumes: 0 }
    let resumed = false
    const { host, fence, messages, exchange } = await openHostRig({
      initialize: RESUMES,
      script: resumes('hi', count),
      deps: { resolveLaunch: launch(() => resumed) }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    resumed = true
    await exchange('hi', true)
    expect(await messages()).toEqual(['hello', 'hi'])
    const before = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    expect(count.resumes).toBe(1)
    expect(await messages()).toEqual(['hello', 'hi'])
    const after = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(after.filter((row) => row.body.kind === 'background-task')).toEqual([])
    expect(after.filter((row) => readAgentJournalTurn(row.body))).toHaveLength(
      before.filter((row) => readAgentJournalTurn(row.body)).length
    )
    await host.close(SESSION, 'user-close')
  })

  it('shows a reply a crash cut off with the existing notice, never completed from what Grok saved', async () => {
    let resumed = false
    const { rig, host, fence, messages, exchange } = await openHostRig({
      initialize: RESUMES,
      script: resumes('complete saved reply', { resumes: 0 }),
      deps: { resolveLaunch: launch(() => resumed) }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    resumed = true
    await exchange('complete', false)
    // Grok dies mid-reply; the host ends its record, which moves the chat's fence.
    const cutAt = fence()
    rig.child().exit()
    await waitFor(() => expect(fence()).toBeGreaterThan(cutAt))
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    expect(await messages()).toEqual(['hello', 'complete'])
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body)?.state ?? [])).not.toContain(
      'completed'
    )
    // The transcript explains the cut the way a Claude or Codex chat's does.
    const transcript = withNativeChatCutTurnNotices(rows, { agentName: 'Grok' })
    expect(
      transcript.some(
        (row) =>
          row.body.kind === 'status' &&
          (row.itemId.includes('cut-turn-notice') ||
            readAgentSessionFailureFact(row.body.failure)?.kind === 'providerExited')
      )
    ).toBe(true)
    await host.close(SESSION, 'user-close')
  })
})

describe('closing or stopping a Grok chat while it starts', () => {
  it('keeps a failed start whose child is not proven gone, so a later close asks it again', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {}),
      deps: { startupTimeoutMs: 30 }
    })
    const attaching = host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    await rig.frame('initialize')
    const child = rig.child()
    child.close = vi.fn(async () => false)
    await host.close(SESSION, 'user-close')
    expect(await attaching).toMatchObject({ name: 'AgentSessionAcquisitionExitUnprovenError' })
    expect(child.exited).toBe(false)
    expect(await rig.adapter.closeSession(SESSION)).toBe(false)
    child.close = vi.fn(async () => {
      child.exit()
      return true
    })
    await host.close(SESSION, 'user-close')
    expect(child.close).toHaveBeenCalled()
    expect(child.exited).toBe(true)
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
  })

  it('refuses a new chat whose start never answered with why, worded like a host-stopped start', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {}),
      deps: { startupTimeoutMs: 30 }
    })
    const attached = await host.attach(CALLER, attachParams())
    expect(attached).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'hostStopped' },
        message: expect.stringContaining('Grok never finished starting, so Orca stopped it.')
      }
    })
    expect(rig.child().exited).toBe(true)
  })

  it('lets a Stop reach a child Grok never finished initializing', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {}),
      deps: { startupTimeoutMs: 60_000 }
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    const stopping = host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    // Long before the startup bound, and with no close behind it.
    await waitFor(() => expect(rig.child().exited).toBe(true))
    expect((await attaching).ok).toBe(false)
    expect(await stopping).toMatchObject({ ok: true })
    expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
  })

  it('cancels a queued send whose start a Stop ended, with no start failure in the chat', async () => {
    let spawns = 0
    const { rig, host } = await openHostRig({
      script: (agent) => {
        spawns += 1
        if (spawns > 1) {
          agent.on('initialize', () => {})
        }
      },
      deps: { startupTimeoutMs: 60_000 }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    // The chat closes; the next send has to start Grok again, and that start never answers.
    await host.close(SESSION, 'user-close')
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: hello }),
      body: hello
    })
    await waitFor(() => expect(spawns).toBe(2))
    await rig.frame('initialize')
    const restarted = rig.child()
    expect(
      await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    ).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(restarted.exited).toBe(true)
    await host.flushStreamedEvents(SESSION)
    const journal = host.collaboratorsForTests().sessions.get(SESSION)!.journal
    expect(journal.submissions()).toMatchObject([
      { dispatchState: 'rejected', rejection: { kind: 'cancelled' } }
    ])
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    expect(rows.filter((row) => row.body.kind === 'status')).toEqual([])
    await host.close(SESSION, 'user-close')
  })

  it('leaves a start alone for a Stop that names a turn of a child already gone', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {}),
      deps: { startupTimeoutMs: 60_000 }
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    const stopping = host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-of-an-old-child' }),
      turnId: 'turn-of-an-old-child'
    })
    await rig.settle()
    expect(rig.child().closes).toBe(0)
    await host.close(SESSION, 'user-close')
    await attaching
    await stopping
  })

  it('never spawns a child for a start closed while its launch was still resolving', async () => {
    let releaseLaunch: () => void = () => {}
    const resolving = { started: false }
    const { rig, host } = await openHostRig({
      deps: {
        resolveLaunch: async () => {
          resolving.started = true
          await new Promise<void>((resolve) => {
            releaseLaunch = resolve
          })
          return launch(() => false)()
        }
      }
    })
    const attaching = host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    await waitFor(() => expect(resolving.started).toBe(true))
    const closing = host.close(SESSION, 'user-close')
    releaseLaunch()
    expect(await attaching).toMatchObject({ name: 'AgentSessionPreSpawnError' })
    await closing
    expect(rig.spawned).toEqual([])
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
  })
})

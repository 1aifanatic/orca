// The ACP adapter behind the real host: the host's own order (a fresh sink per start, bound only
// once the start proved its owner; Close and Stop reaching a start from outside the session's
// queue), with a scripted Grok, the real record store and an on-disk journal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionStoredAgents } from '../../shared/agent-session-stored-agent'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
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
  const rig = await openAcpAdapterRig({
    ...options,
    deps: {
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

/** On every load, Grok replays the exchange it saved: the user's `hello`, then `reply`. */
function replays(reply: string, loads: { count: number }) {
  return (agent: AcpScriptedAgent) =>
    agent.on('session/load', (frame) => {
      loads.count += 1
      agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
        _meta: { isReplay: true }
      })
      agent.notify('session/update', replyChunk('prompt:m1', reply, { isReplay: true }))
      agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
    })
}

describe('resuming a Grok chat through the host', () => {
  it('writes the user message once when Grok replays an exchange the journal holds', async () => {
    const loads = { count: 0 }
    let resumed = false
    const { host, fence, messages, exchange } = await openHostRig({
      script: replays('hi', loads),
      deps: { resolveLaunch: launch(() => resumed) }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    resumed = true
    await exchange('hi', true)
    expect(await messages()).toEqual(['hello', 'hi'])
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    expect(loads.count).toBe(1)
    expect(await messages()).toEqual(['hello', 'hi'])
    await host.close(SESSION, 'user-close')
  })

  it('recovers the reply Grok saved past what an unfinished turn journaled, and keeps its end', async () => {
    let resumed = false
    const { host, fence, messages, exchange } = await openHostRig({
      script: replays('complete saved reply', { count: 0 }),
      deps: { resolveLaunch: launch(() => resumed) }
    })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    resumed = true
    await exchange('complete', false)
    await host.close(SESSION, 'user-close')
    expect(await host.attach(CALLER, attachParams(fence()))).toMatchObject({ ok: true })
    await host.flushStreamedEvents(SESSION)
    expect(await messages()).toEqual(['hello', 'complete saved reply'])
    const rows = (await host.history({ sessionId: SESSION, direction: 'tail' })).page.items
    // The replay recovers content; it never says how the turn ended.
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body)?.state ?? [])).not.toContain(
      'running'
    )
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

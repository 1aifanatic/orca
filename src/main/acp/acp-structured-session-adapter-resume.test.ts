import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  replyChunk,
  sendHello,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

/** Grok's own capabilities: it loads and resumes sessions. */
const RESUMES = { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }
const resume = { launch: { resume: { sessionId: PROVIDER_SESSION, replaceableKey: null } } }

/** Everything Grok may send while it reattaches: its saved exchange marked as replay, a task the
 *  dead process left running ended by the restart, and its context usage. */
function sendsWhileAttaching(agent: AcpScriptedAgent, reply: string): void {
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
    _meta: { isReplay: true }
  })
  agent.notify('session/update', replyChunk('prompt:m1', reply, { isReplay: true }))
  agent.notify('x.ai/task_completed', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 'task-orphan', command: 'sleep 600', signal: 'session_restart' }
    }
  })
  agent.notify('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'usage_update', used: 4_000, size: 200_000 }
  })
}

/** Orca's send of `hello` as `m1` and Grok's reply, ended or cut off. */
async function exchange(rig: AcpAdapterRig, reply: string, end: boolean): Promise<void> {
  await rig.rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
    turnScope: { kind: 'thread' }
  })
  await sendHello(rig, 'm1')
  const prompt = await rig.frame('session/prompt')
  rig.child().agent.notify('session/update', replyChunk('prompt:m1', reply))
  if (end) {
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
  }
  await rig.settle()
}

const texts = async (rig: AcpAdapterRig) =>
  (await rig.rig.rows()).flatMap((row) => messageText(row.body) ?? [])

/** What Grok might send while it resumes with no replay mark: an old reply and its turn's end. */
function sendsUnmarkedWhileAttaching(agent: AcpScriptedAgent): void {
  agent.notify('session/update', replyChunk('prompt:old', 'stale text'))
  agent.notify('x.ai/session_notification', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'turn_completed', prompt_id: 'prompt:old', stop_reason: 'end_turn' }
  })
}

describe('the reattach window', () => {
  const resumesUnmarked = {
    ...resume,
    initialize: RESUMES,
    script: (agent: AcpScriptedAgent) =>
      agent.on('session/resume', (frame) => {
        sendsUnmarkedWhileAttaching(agent)
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      })
  }

  it('writes nothing Grok sends while it resumes, even unmarked as replay', async () => {
    const rig = await openAcpAdapterRig(resumesUnmarked)
    await rig.acquire()
    await rig.settle()
    expect(await rig.rig.rows()).toEqual([])
  })

  it('leaves no turn from the window for a later Stop to find', async () => {
    const rig = await openAcpAdapterRig(resumesUnmarked)
    await rig.acquire()
    await rig.settle()
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: false,
      refusal: { turnNotRunning: true }
    })
    expect(rig.child().closes).toBe(0)
  })
})

describe('reattaching a Grok chat the journal holds', () => {
  it('resumes with session/resume and writes nothing Grok sends while it resumes', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/resume', (frame) => {
          sendsWhileAttaching(agent, 'hi')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'hi', true)
    const before = (await rig.rig.rows()).map((row) => row.itemId)
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    expect(rig.sent('session/resume')).toHaveLength(1)
    expect(rig.sent('session/load')).toHaveLength(0)
    // No second user bubble, no stale task row, and no turn opened by the resume's own traffic.
    expect((await rig.rig.rows()).map((row) => row.itemId)).toEqual(before)
    expect(await texts(rig)).toEqual(['hello', 'hi'])
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 2 })).resolves.toEqual({
      cancelled: false,
      refusal: { turnNotRunning: true }
    })
  })

  it('loads an agent that only loads, writing none of what it replays', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          sendsWhileAttaching(agent, 'hi')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'hi', true)
    const before = await rig.rig.rows()
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    expect(rig.sent('session/resume')).toHaveLength(0)
    expect((await rig.rig.rows()).map((row) => row.itemId)).toEqual(before.map((row) => row.itemId))
    expect(await texts(rig)).toEqual(['hello', 'hi'])
  })

  it('leaves a reply cut off mid-turn as it was cut, never completed from what Grok saved', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          sendsWhileAttaching(agent, 'complete saved reply')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'complete', false)
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    const rows = await rig.rig.rows()
    expect(await texts(rig)).toEqual(['hello', 'complete'])
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body)?.state ?? [])).toEqual([
      'unverifiable'
    ])
  })

  it('writes nothing of the reattach into a sink the host binds only after the start', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/resume', (frame) => {
          sendsWhileAttaching(agent, 'hi')
          agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
        })
    })
    await rig.acquire()
    await exchange(rig, 'hi', true)
    await rig.adapter.closeSession(SESSION)
    const before = await rig.rig.rows()
    // The host's order: a fresh sink per start, bound to the journal once the start succeeded.
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging(SESSION))
    await rig.adapter.acquire({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'grok',
        providerHandle: null
      },
      fence: 2,
      spawnToken: 'spawn-2',
      events: deferred.sink
    })
    deferred.bind({ journal: rig.rig.journal, fence: 2, publish: () => {} })
    expect(await deferred.drained()).toMatchObject({ ok: true })
    expect((await rig.rig.rows()).map((row) => row.itemId)).toEqual(before.map((row) => row.itemId))
    await rig.adapter.closeSession(SESSION)
    deferred.close()
  })

  it('starts a new session in place of a created one that session/resume reports missing', async () => {
    const rig = await openAcpAdapterRig({
      launch: { resume: { sessionId: 'never-saved', replaceableKey: 'acp:grok:never-saved' } },
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/resume', (frame) => agent.fail(frame, -32002, 'Resource not found'))
    })
    const acquired = await rig.acquire()
    expect(acquired.link).toMatchObject({
      origin: 'created',
      handle: { nativeId: PROVIDER_SESSION },
      supersedesKey: 'acp:grok:never-saved'
    })
    // The failed resume left the translator taking prompts.
    await exchange(rig, 'hi', true)
    expect(await texts(rig)).toEqual(['hello', 'hi'])
  })

  it('keeps the slash commands Grok reports while it resumes', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      initialize: RESUMES,
      script: (agent) =>
        agent.on('session/resume', (frame) => {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'compact', description: 'Compress', input: null }]
            }
          })
          agent.reply(frame, { configOptions: [] })
        })
    })
    await rig.acquire()
    await rig.settle()
    expect(rig.adapter.readCommands(SESSION)).toEqual([
      { name: 'compact', kind: 'command', description: 'Compress' }
    ])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../shared/agent-session-journal-item-key'
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
  sendHello
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const hello: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'hello' }]
}

const userChunk = (text: string) => ({
  sessionId: PROVIDER_SESSION,
  update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
  _meta: { isReplay: true }
})

/** Grok answers every load after the first by replaying the turn `promptId` it saved. */
function replaysOnReload(promptId: string, reply: string) {
  let loads = 0
  return (agent: AcpScriptedAgent) =>
    agent.on('session/load', (frame) => {
      if (loads++ > 0) {
        agent.notify('session/update', userChunk('hello'))
        agent.notify('session/update', replyChunk(promptId, reply, { isReplay: true }))
      }
      agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
    })
}

const resume = { launch: { resume: { sessionId: PROVIDER_SESSION, replaceableKey: null } } }

describe('ACP resume reconciles what the agent replays against the journal', () => {
  it('writes nothing again for a turn the journal already settled', async () => {
    const rig = await openAcpAdapterRig({ ...resume, script: replaysOnReload('prompt:m1', 'hi') })
    await rig.acquire()
    await rig.rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
      turnScope: { kind: 'thread' }
    })
    await sendHello(rig, 'm1')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:m1', 'hi'))
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
    const before = await rig.rig.rows()
    expect(before.some((row) => messageText(row.body) === 'hi')).toBe(true)
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    expect(await rig.rig.rows()).toEqual(before)
  })

  it('takes the rest of a reply Grok saved for a turn that ended without its end', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: replaysOnReload('prompt:m1', 'complete saved reply')
    })
    await rig.acquire()
    await rig.rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
      turnScope: { kind: 'thread' }
    })
    await sendHello(rig, 'm1')
    await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:m1', 'complete'))
    await rig.settle()
    // The child goes mid-reply: the turn is left unverifiable, not completed.
    await rig.adapter.closeSession(SESSION)
    await rig.acquire({ fence: 2 })
    await rig.settle()
    const rows = await rig.rig.rows()
    expect(rows.flatMap((row) => messageText(row.body) ?? [])).toEqual([
      'hello',
      'complete saved reply'
    ])
    expect(rows.flatMap((row) => readAgentJournalTurn(row.body)?.state ?? [])).toEqual([
      'unverifiable'
    ])
  })

  it('writes nothing for a completed turn replayed into a sink bound only after the load', async () => {
    const rig = await openAcpAdapterRig({ ...resume, script: replaysOnReload('prompt:m1', 'hi') })
    await rig.acquire()
    await rig.rig.eventSink.appendItem({ provider: 'orca', clientMessageId: 'm1' }, hello, {
      turnScope: { kind: 'thread' }
    })
    await sendHello(rig, 'm1')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:m1', 'hi'))
    rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
    await rig.settle()
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
    expect(await rig.rig.rows()).toEqual(before)
    await rig.adapter.closeSession(SESSION)
    deferred.close()
  })

  it('adopts a reply Grok saved that Orca never wrote, joined to the send already in the journal', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
          agent.notify('session/update', userChunk('hello'))
          agent.notify(
            'session/update',
            replyChunk('prompt:old-message', 'Saved reply after host crash', { isReplay: true })
          )
          agent.reply(frame, { configOptions: [] })
        })
    })
    // Orca wrote the send, then crashed before any of Grok's reply reached the journal.
    await rig.rig.eventSink.appendItem(
      { provider: 'orca', clientMessageId: 'old-message' },
      hello,
      {
        turnScope: { kind: 'thread' }
      }
    )
    await rig.settle()
    await rig.acquire({ fence: 2 })
    await rig.settle()
    const rows = await rig.rig.rows()
    const messages = rows.filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => messageText(row.body))).toEqual([
      'hello',
      'Saved reply after host crash'
    ])
    const turn = rows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turn).toMatchObject([
      { state: 'completed', userItemId: agentJournalSubmissionKey('old-message') }
    ])
  })

  it('keeps the slash commands Grok reports while it loads', async () => {
    const rig = await openAcpAdapterRig({
      ...resume,
      script: (agent) =>
        agent.on('session/load', (frame) => {
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

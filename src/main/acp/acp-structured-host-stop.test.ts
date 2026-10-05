// A Grok chat's Stop through the real host: it ends the process once Grok settles its turn, and the
// next send resumes the session.

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { withNativeChatCutTurnNotices } from '../../shared/native-chat-cut-turn-notice'
import {
  closeProviderTimelineRigs,
  providerTurnId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { FakeFrame } from './acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  PROVIDER_SESSION,
  replyChunk,
  waitFor,
  type FakeAcpChild
} from './acp-structured-adapter.test-support'
import { attachParams, launch, openHostRig, RESUMES } from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const promptMeta = z.object({ _meta: z.object({ promptId: z.string() }) })
const promptIdOf = (frame: FakeFrame): string => promptMeta.parse(frame.params)._meta.promptId

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = message(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error('send refused')
  }
  return sent.value.clientMessageId
}

function stop(host: StructuredAgentSessionHost, turnId?: string) {
  return turnId === undefined
    ? host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    : host.cancel(CALLER, { envelope: envelope('agentSession.cancel', { turnId }), turnId })
}

const methods = (child: FakeAcpChild, method: string) =>
  child.agent.frames.filter((frame) => frame.method === method)

/** A Grok that resumes its session, counting each resume. */
async function openResumingRig() {
  const count = { resumes: 0 }
  let resumed = false
  const rig = await openHostRig({
    initialize: RESUMES,
    script: (agent) =>
      agent.on('session/resume', (frame) => {
        count.resumes += 1
        agent.reply(frame, { configOptions: GROK_CONFIG_OPTIONS })
      }),
    deps: { resolveLaunch: launch(() => resumed) }
  })
  expect(await rig.host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
  resumed = true
  const rows = async () => {
    await rig.host.flushStreamedEvents(SESSION)
    return (await rig.host.history({ sessionId: SESSION, direction: 'tail' })).page.items
  }
  const turns = async () => (await rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
  return { ...rig, count, rows, turns }
}

describe('a Grok chat Stop', () => {
  it('ends Grok once it settles the turn, and the next send resumes with no notice', async () => {
    const { rig, host, count, rows, turns, messages } = await openResumingRig()
    const first = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    first.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'partial'))
    first.agent.on('session/cancel', () => first.agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
    await waitFor(() => expect(first.exited).toBe(true))
    expect(methods(first, 'session/cancel')).toHaveLength(1)
    expect((await turns()).at(-1)).toMatchObject({ state: 'interrupted' })

    await send(host, 'again')
    await waitFor(() => expect(rig.child()).not.toBe(first))
    const second = rig.child()
    await rig.frame('session/prompt')
    expect(count.resumes).toBe(1)
    expect(methods(second, 'session/new')).toHaveLength(0)
    expect(await messages()).toEqual(['hello', 'partial', 'again'])
    // Only the Stop's own note: no exit or cut-reply notice for a Stop the person asked for.
    const transcript = withNativeChatCutTurnNotices(await rows(), { agentName: 'Grok' })
    expect(
      transcript.flatMap((row) => (row.body.kind === 'status' ? [row.body.text] : []))
    ).toEqual(['Cancellation requested.'])
    await host.close(SESSION, 'user-close')
  })

  it('ends Grok on a Stop of a turn it began itself, once that turn ends', async () => {
    const { rig, host, turns } = await openResumingRig()
    const { agent } = rig.child()
    agent.notify('session/update', replyChunk('task-completed-background-1', 'Working on it'))
    agent.on('session/cancel', () =>
      agent.notify('x.ai/session_notification', {
        sessionId: PROVIDER_SESSION,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'task-completed-background-1',
          stop_reason: 'cancelled'
        }
      })
    )
    await rig.settle()
    expect((await turns()).at(-1)).toMatchObject({ state: 'running' })
    expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
    await waitFor(() => expect(rig.child().exited).toBe(true))
    expect(methods(rig.child(), 'session/cancel')).toHaveLength(1)
    expect((await turns()).at(-1)).toMatchObject({ state: 'interrupted' })
    await host.close(SESSION, 'user-close')
  })

  it('leaves no Grok behind whose background work could begin a turn after the Stop', async () => {
    const { rig, host, turns } = await openResumingRig()
    const first = rig.child()
    await send(host, 'hello')
    const prompt = await rig.frame('session/prompt')
    first.agent.notify('session/update', replyChunk(promptIdOf(prompt), 'started a build'))
    first.agent.on('session/cancel', () => first.agent.reply(prompt, { stopReason: 'cancelled' }))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    await stop(host)
    await waitFor(() => expect(first.exited).toBe(true))
    const settled = await turns()
    // What a kept process would do once its backgrounded build finished.
    first.agent.notify('session/update', replyChunk('task-completed-background-1', 'Build done'))
    await rig.settle()
    expect(await turns()).toEqual(settled)
    expect(settled.map((turn) => turn.state)).not.toContain('running')
    await host.close(SESSION, 'user-close')
  })
})

describe('a Grok chat Stop naming a turn that has ended', () => {
  it('stops neither the turn running now nor Grok', async () => {
    const { rig, host, turns } = await openResumingRig()
    const { agent } = rig.child()
    await send(host, 'old')
    const old = await rig.frame('session/prompt')
    agent.notify('session/update', replyChunk(promptIdOf(old), 'done'))
    agent.reply(old, { stopReason: 'end_turn' })
    await rig.settle()
    await send(host, 'new')
    const current = await rig.frame('session/prompt', 1)
    agent.notify('session/update', replyChunk(promptIdOf(current), 'working'))
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    const stopped = await stop(host, providerTurnId(promptIdOf(old), PROVIDER_SESSION))
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    await rig.settle()
    expect(methods(rig.child(), 'session/cancel')).toHaveLength(0)
    expect(rig.child().exited).toBe(false)
    expect((await turns()).at(-1)).toMatchObject({ state: 'running' })
    await host.close(SESSION, 'user-close')
  })

  it('stops nothing in the gap before Grok echoes the next prompt', async () => {
    const { rig, host } = await openResumingRig()
    const { agent } = rig.child()
    await send(host, 'old')
    const old = await rig.frame('session/prompt')
    agent.notify('session/update', replyChunk(promptIdOf(old), 'done'))
    agent.reply(old, { stopReason: 'end_turn' })
    await rig.settle()
    await send(host, 'new')
    await rig.frame('session/prompt', 1)
    await host.flushStreamedEvents(SESSION)
    const stopped = await stop(host, providerTurnId(promptIdOf(old), PROVIDER_SESSION))
    expect(stopped).toMatchObject({ ok: true, value: { cancelled: false } })
    await rig.settle()
    expect(methods(rig.child(), 'session/cancel')).toHaveLength(0)
    expect(rig.child().exited).toBe(false)
    await host.close(SESSION, 'user-close')
  })
})

// A message sent while a Grok prompt runs steers: the running prompt is cancelled (the session
// stays) and the message goes as the next prompt. The adapter holds a steer only while that cancel
// lands; the host's queue holds everything else.

import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { DISPATCH_REJECTED_CANCELLED } from '../../shared/structured-agent-session-dispatch-rejection'
import {
  closeProviderTimelineRigs,
  SESSION as ADAPTER_SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { AcpScriptedAgent, FakeFrame } from './acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  replyChunk,
  sendHello,
  waitFor
} from './acp-structured-adapter.test-support'
import {
  framesOf,
  message,
  openAttachedHostRig,
  promptIdOf,
  send,
  stop
} from './acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

/** Grok answers each cancel by ending the prompt it is running, as `cancelled`. */
function answersCancels(agent: AcpScriptedAgent): void {
  agent.on('session/cancel', () => {
    const answered = new Set(agent.frames.flatMap((frame) => (frame.method ? [] : [frame.id])))
    const running = agent.frames.findLast(
      (frame): frame is FakeFrame => frame.method === 'session/prompt' && !answered.has(frame.id)
    )
    if (running) {
      agent.reply(running, { stopReason: 'cancelled' })
    }
  })
}

describe('a send while a Grok prompt runs', () => {
  it('cancels the running prompt, then sends as the next one', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    const first = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:first', 'working'))
    await rig.settle()
    await sendHello(rig, 'steer')
    await rig.settle()
    expect(rig.sent('session/cancel')).toHaveLength(1)
    expect(rig.sent('session/prompt')).toHaveLength(1)
    rig.child().agent.reply(first, { stopReason: 'cancelled' })
    const second = await rig.frame('session/prompt', 1)
    expect(promptIdOf(second)).toBe('prompt:steer')
    rig.child().agent.notify('session/update', replyChunk('prompt:steer', 'on it'))
    await waitFor(async () => {
      const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
      expect(turns.map((turn) => turn.state)).toEqual(['interrupted', 'running'])
    })
    // A cancel, not a Stop: the session stays.
    expect(rig.child().closes).toBe(0)
  })

  it('runs the last of two quick steers; the one between is sent and cancelled', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.frame('session/prompt')
    await rig.settle()
    await sendHello(rig, 'steer-1')
    await sendHello(rig, 'steer-2')
    await rig.settle()
    // One cancel per running prompt, however many steers wait behind it.
    expect(rig.sent('session/cancel')).toHaveLength(1)
    answersCancels(rig.child().agent)
    rig.child().agent.reply(rig.sent('session/prompt')[0]!, { stopReason: 'cancelled' })
    await rig.frame('session/prompt', 2)
    await rig.settle()
    expect(rig.sent('session/prompt').map(promptIdOf)).toEqual([
      'prompt:first',
      'prompt:steer-1',
      'prompt:steer-2'
    ])
    expect(rig.sent('session/cancel')).toHaveLength(2)
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['first', 'steer-1'])
  })

  it('withdraws a steer a Stop reaches before its cancel lands', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'first')
    const first = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:first', 'working'))
    await rig.settle()
    await sendHello(rig, 'steer')
    await expect(rig.adapter.cancelTurn({ sessionId: ADAPTER_SESSION, fence: 1 })).resolves.toEqual(
      {
        cancelled: true
      }
    )
    rig.child().agent.reply(first, { stopReason: 'cancelled' })
    await rig.settle()
    expect(rig.sent('session/prompt')).toHaveLength(1)
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'steer', state: 'rejected' })
      ])
    )
  })
})

describe('Steer on a Grok card, through the host', () => {
  /** A Grok turn running, and a card queued behind it. */
  async function cardBehindARunningTurn() {
    const rig = await openAttachedHostRig({ stopGraceMs: 20 })
    const { host } = rig
    await send(host, 'hello')
    const prompt = await rig.rig.frame('session/prompt')
    rig.rig.child().agent.notify('session/update', replyChunk(promptIdOf(prompt), 'working'))
    await rig.rig.settle()
    await host.flushStreamedEvents(SESSION)
    const body = message('and then this')
    const delivery = 'queue-if-active' as const
    const queued = await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body, delivery }),
      body,
      delivery,
      userSend: true
    })
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued card')
    }
    const cardId = queued.value.queued.messageId
    const sendNow = () =>
      host.queuedMessageSend(CALLER, {
        envelope: envelope('agentSession.queuedMessageSend', { messageId: cardId }),
        messageId: cardId
      })
    const page = async () => {
      await host.flushStreamedEvents(SESSION)
      const history = await host.history({ sessionId: SESSION, direction: 'tail' })
      return history.ok ? history.page : null
    }
    const sends = async () =>
      (await host.journalSnapshot(SESSION)).submissions
        .filter((entry) => entry.queuedMessageId === cardId)
        .map((entry) => ({ state: entry.dispatchState, reason: entry.reason }))
    return { ...rig, prompt, cardId, sendNow, page, sends }
  }

  it('leaves the card in the host queue while the turn runs, and cancels then sends it on Steer', async () => {
    const { rig, host, prompt, sendNow, page, sends } = await cardBehindARunningTurn()
    const { agent } = rig.child()
    await rig.settle()
    // Queued, not sent: nothing reaches Grok and the card stays editable.
    expect((await page())?.queuedMessages?.map((card) => card.state)).toEqual(['waiting'])
    expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
    expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(0)

    expect(await sendNow()).toMatchObject({ ok: true })
    await waitFor(() => expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(1))
    expect(framesOf(rig.child(), 'session/prompt')).toHaveLength(1)
    agent.reply(prompt, { stopReason: 'cancelled' })
    const steered = await rig.frame('session/prompt', 1)
    agent.notify('session/update', replyChunk(promptIdOf(steered), 'on it'))
    await waitFor(async () => expect(await sends()).toMatchObject([{ state: 'accepted' }]))
    expect((await page())?.queuedMessages ?? []).toEqual([])
    expect(rig.child().exited).toBe(false)
    await host.close(SESSION, 'user-close')
  })

  it("steers an older client's send the same way", async () => {
    const rig = await openAttachedHostRig()
    const { agent } = rig.rig.child()
    await send(rig.host, 'hello')
    const prompt = await rig.rig.frame('session/prompt')
    agent.notify('session/update', replyChunk(promptIdOf(prompt), 'working'))
    await rig.rig.settle()
    await rig.host.flushStreamedEvents(SESSION)
    // No queued-message delivery: the host hands it over while the turn runs.
    await send(rig.host, 'steer')
    await waitFor(() => expect(framesOf(rig.rig.child(), 'session/cancel')).toHaveLength(1))
    agent.reply(prompt, { stopReason: 'cancelled' })
    await rig.rig.frame('session/prompt', 1)
    await rig.host.close(SESSION, 'user-close')
  })

  it('brings the card back paused when a Stop reaches it before the cancel lands', async () => {
    const { rig, host, sendNow, page, sends } = await cardBehindARunningTurn()
    expect(await sendNow()).toMatchObject({ ok: true })
    await waitFor(() => expect(framesOf(rig.child(), 'session/cancel')).toHaveLength(1))
    const first = rig.child()
    expect(await stop(host)).toMatchObject({ ok: true, value: { cancelled: true } })
    await waitFor(() => expect(first.exited).toBe(true))
    expect(framesOf(first, 'session/prompt')).toHaveLength(1)
    await waitFor(async () => {
      const current = await page()
      expect({
        pause: current?.queuePause ?? null,
        cards: (current?.queuedMessages ?? []).map((card) => card.state),
        sends: await sends()
      }).toEqual({
        pause: { reason: 'stopped' },
        cards: ['waiting'],
        sends: [{ state: 'rejected', reason: DISPATCH_REJECTED_CANCELLED }]
      })
    })
    await host.close(SESSION, 'user-close')
  })
})

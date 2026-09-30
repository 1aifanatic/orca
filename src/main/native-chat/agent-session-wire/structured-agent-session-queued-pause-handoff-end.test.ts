// A Stop's queue pause kept alive only by a card's unanswered hand-off ends on every path that
// ends that hand-off, so no lost answer pauses a chat's queue for good: the provider answering
// it, the chat closing, a restart, the provider dying without answering, and a /clear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string, sessionId = HOST_TEST_SESSION): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  expect(
    (await rig.drafts(sessionId)).some((card) => card.messageId === queued.value.queued.messageId)
  )
  return queued.value.queued.messageId
}

/** The stored Stop fact, read from the open conversation (opened by a history read if closed). */
async function stopFact(sessionId = HOST_TEST_SESSION) {
  await rig.drafts(sessionId)
  const journal = rig.host.collaboratorsForTests().sessions.get(sessionId)?.journal
  if (!journal) {
    throw new Error('expected the conversation open')
  }
  return journal.queuedMessages.pause()
}

/** A card sent now into the running turn, then Stop, with the provider answering neither: the
 *  pause is recorded over that unanswered hand-off alone, and is not shown. */
async function stopOverUnansweredHandOff(): Promise<{ working: string; sentId: string }> {
  const working = await rig.workingSend()
  const sentId = await queuedDraft('sent now into the turn')
  await rig.sendNow(sentId)
  await eventually(async () => expect((await rig.handoff(sentId))?.handedOverAt).toBeDefined())
  expect(await rig.stop()).toMatchObject({ ok: true })
  expect(await stopFact()).toMatchObject({ reason: 'stopped' })
  expect(await rig.queuePause()).toBeNull()
  return { working, sentId }
}

/** The queue sends on its own again: a card typed during a later mail turn drains after it. */
async function expectQueueDrains(): Promise<void> {
  expect(await stopFact()).toBeNull()
  expect(await rig.queuePause()).toBeNull()
  const mail = rig.send('coordinator mail', undefined, { internal: true })
  await mail.result
  await eventually(async () => expect((await rig.submission(mail.id))?.handedOverAt).toBeDefined())
  const later = await queuedDraft('typed during the mail turn')
  await rig.settleAccepted(mail.id, 'mail')
  await eventually(async () => expect(await rig.handoff(later)).toBeDefined())
}

/** The provider's answer that the Stop took the card back before it reached the agent. */
async function withdraw(draftId: string): Promise<void> {
  await rig.host.settleLateDispatch({
    sessionId: HOST_TEST_SESSION,
    clientMessageId: await rig.handoffId(draftId),
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
  })
}

function clear() {
  const fields = { command: 'clear' as const }
  return rig.host.conversationCommand(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
}

function providerExited() {
  return rig.host.handleAdapterEvent({
    type: 'ended',
    sessionId: HOST_TEST_SESSION,
    reason: 'provider exited',
    cause: 'unexpected-exit',
    fence: 1,
    acquisitionGeneration: 'generation-1'
  })
}

describe('a pause held only by an unanswered hand-off', () => {
  it('the provider withdrawing it leaves the card waiting under the pause; Resume sends it', async () => {
    const { working, sentId } = await stopOverUnansweredHandOff()
    await withdraw(sentId)
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.drafts()).toEqual([{ messageId: sentId, state: 'waiting' }])
    expect(await rig.resume()).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(sentId))?.origin).toBe('host'))
  })

  it('ends when the provider dies without answering it', async () => {
    const { sentId } = await stopOverUnansweredHandOff()
    await providerExited()
    // The dead generation's settlement: in doubt, never back to waiting.
    await eventually(async () => expect((await rig.handoff(sentId))?.dispatchState).toBe('unknown'))
    await expectQueueDrains()
  })

  it('ends when the chat closes', async () => {
    const { sentId } = await stopOverUnansweredHandOff()
    await rig.host.close(HOST_TEST_SESSION)
    expect((await rig.handoff(sentId))?.dispatchState).toBe('unknown')
    await expectQueueDrains()
  })

  it('ends when the host restarts under it', async () => {
    const { sentId } = await stopOverUnansweredHandOff()
    await rig.restartHostProcess()
    expect((await rig.handoff(sentId))?.dispatchState).toBe('unknown')
    await expectQueueDrains()
  })

  it('a withdrawal the restart finds still owed is settled at open, under the pause; Resume sends it', async () => {
    const { working, sentId } = await stopOverUnansweredHandOff()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hook = vi
      .spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction')
      .mockImplementationOnce(() => {
        throw new Error('bookkeeping failed')
      })
    try {
      await withdraw(sentId)
    } finally {
      hook.mockRestore()
      warn.mockRestore()
    }
    await rig.settleAccepted(working, 'stopped')
    await rig.restartHostProcess()
    expect(await rig.drafts()).toEqual([{ messageId: sentId, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
    expect(await rig.resume()).toMatchObject({ ok: true })
    await eventually(async () => expect((await rig.handoff(sentId))?.origin).toBe('host'))
  })

  it("waits for it before a /clear, which then carries every waiting card paused 'cleared'", async () => {
    const { working, sentId } = await stopOverUnansweredHandOff()
    const carriedId = await queuedDraft('waiting behind the stop')
    await rig.settleAccepted(working, 'stopped')
    // An unanswered send blocks /clear: the hand-off ends first, by one of the paths above.
    expect(await clear()).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'messagesUnsettled' } }
    })
    await withdraw(sentId)
    const cleared = await clear()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error(`expected a replacement session: ${JSON.stringify(cleared)}`)
    }
    // The superseded chat keeps no pause over the cards it gave away.
    expect(await stopFact()).toBeNull()
    expect(await rig.drafts(replacementId)).toEqual([
      { messageId: sentId, state: 'waiting' },
      { messageId: carriedId, state: 'waiting' }
    ])
    expect(await rig.queuePause(replacementId)).toEqual({ reason: 'cleared' })
    const resumed = await rig.host.queuedMessagesResume(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(
        {},
        'agentSession.queuedMessagesResume',
        hostTestOperationId(),
        replacementId
      )
    })
    expect(resumed).toMatchObject({ ok: true })
    await eventually(async () =>
      expect(
        (await rig.host.journalSnapshot(replacementId)).submissions.some(
          (entry) => entry.queuedMessageId === sentId
        )
      ).toBe(true)
    )
  })
})

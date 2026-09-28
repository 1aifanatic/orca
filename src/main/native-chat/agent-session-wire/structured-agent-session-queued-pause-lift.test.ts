// A Stop's queue pause dies only when a user send made after it actually starts
// a turn — the provider accepts it — never at the host's acceptance of the send.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

/** No drain step may convert the draft: wait out any that were scheduled. */
async function expectNeverSent(draftId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(await rig.submission(draftId)).toBeUndefined()
  expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting', paused: true }])
}

/** A draft held by a Stop, with the stopped turn settled so the session is idle. */
async function stoppedDraft(): Promise<string> {
  const working = await rig.workingSend()
  const queued = await rig.send('paused by stop', 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  await rig.stop()
  await rig.settleAccepted(working, 'stopped')
  return queued.value.queued.messageId
}

/** A user send the host accepted and handed over, still unanswered by the provider. */
async function handedOverUserSend(text: string): Promise<string> {
  const { id, result } = rig.send(text)
  expect(await result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
  return id
}

describe("a Stop's queue pause", () => {
  it('outlives a user send the provider accepts and then refuses; a later send that starts lifts it', async () => {
    const draftId = await stoppedDraft()
    const refused = await handedOverUserSend('the start fails')
    expect(await rig.drafts()).toEqual([{ messageId: draftId, state: 'waiting', paused: true }])
    await rig.settleRejected(refused, 'turn/start refused')
    await expectNeverSent(draftId)
    const started = await handedOverUserSend('this one starts')
    await rig.settleAccepted(started, 'started')
    await eventually(async () => expect(await rig.submission(draftId)).toBeDefined())
  })

  it('a Stop after the user send supersedes it: that send starting its turn lifts nothing', async () => {
    const draftId = await stoppedDraft()
    const earlier = await handedOverUserSend('sent before the second stop')
    await rig.stop()
    await rig.settleAccepted(earlier, 'late')
    await expectNeverSent(draftId)
  })

  it('a restart between the send and its turn start forgets the send: nothing goes out unasked', async () => {
    const draftId = await stoppedDraft()
    const inFlight = await handedOverUserSend('sent before the restart')
    // The stored hold and the row survive; this process's memory of the send does not.
    rig.restartHostProcess()
    await rig.settleAccepted(inFlight, 'after-restart')
    await expectNeverSent(draftId)
  })
})

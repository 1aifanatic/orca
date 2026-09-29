// A consumed draft whose submission a Stop withdrew before the agent had it is
// not a failure: it waits again at its own position under the Stop's hold, so
// it never blocks the paused cards behind it. After the user's next turn the
// whole queue drains one per turn in queue order, the withdrawn draft first,
// under a fresh submission id.

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QUEUED_MESSAGE_PAUSED_STOPPED } from '../../../shared/agent-session-wire'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
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

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

async function submissionIds(): Promise<string[]> {
  return (await rig.host.journalSnapshot(SESSION)).submissions.map((entry) => entry.clientMessageId)
}

async function handedOver(id: string): Promise<void> {
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
}

it('Stop, then a user send: the withdrawn draft and the paused cards behind it drain one per turn, in queue order', async () => {
  const working = await rig.workingSend()
  const a = await queuedDraft('A')
  const b = await queuedDraft('B')
  const c = await queuedDraft('C')
  // The turn ends and the drain consumes A; the agent's start is held, so A is not handed over.
  let release: () => void = () => undefined
  rig.awaitStarted.mockImplementationOnce(
    () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
  )
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.submission(a)).toBeDefined())
  expect((await rig.submission(a))?.handedOverAt).toBeUndefined()

  expect(await rig.stop()).toMatchObject({ ok: true })
  release()
  // A is back in its place, paused exactly like B and C: no returned card blocks them.
  const paused = [a, b, c].map((messageId) => ({ messageId, state: 'waiting', paused: true }))
  expect(await rig.drafts()).toEqual(paused)
  const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(page.ok && page.page.queuedMessages?.map((card) => card.pausedReason)).toEqual([
    QUEUED_MESSAGE_PAUSED_STOPPED,
    QUEUED_MESSAGE_PAUSED_STOPPED,
    QUEUED_MESSAGE_PAUSED_STOPPED
  ])

  const d = rig.send('D')
  await d.result
  await handedOver(d.id)
  expect(await rig.drafts()).toEqual(paused)
  await rig.settleAccepted(d.id, 'd')

  // After D's turn, A drains first, under a fresh id: its own names the withdrawn submission.
  const before = new Set([working, a, d.id])
  let resentA = ''
  await eventually(async () => {
    const fresh = (await submissionIds()).filter((id) => !before.has(id))
    expect(fresh).toHaveLength(1)
    resentA = fresh[0] ?? ''
  })
  expect((await rig.submission(a))?.dispatchState).toBe('rejected')
  expect((await rig.submission(resentA))?.payloadFingerprint).toBe(
    (await rig.submission(a))?.payloadFingerprint
  )
  expect(await rig.drafts()).toEqual([
    { messageId: b, state: 'waiting' },
    { messageId: c, state: 'waiting' }
  ])

  await handedOver(resentA)
  await rig.settleAccepted(resentA, 'a')
  await eventually(async () => expect(await rig.submission(b)).toBeDefined())
  expect(await rig.submission(c)).toBeUndefined()
  await handedOver(b)
  await rig.settleAccepted(b, 'b')
  await eventually(async () => expect(await rig.submission(c)).toBeDefined())
  expect(await rig.drafts()).toEqual([])
})

it('a Stop that fails after withdrawing a consumed draft releases it, and it sends again under a fresh id', async () => {
  const working = await rig.workingSend()
  const a = await queuedDraft('A')
  let release: () => void = () => undefined
  rig.awaitStarted.mockImplementationOnce(
    () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
  )
  await rig.settleAccepted(working, 'working')
  await eventually(async () => expect(await rig.submission(a)).toBeDefined())
  const withdraw = AgentSessionJournal.prototype.rejectQueuedSubmissions
  const failing = vi
    .spyOn(AgentSessionJournal.prototype, 'rejectQueuedSubmissions')
    .mockImplementation(async function (this: AgentSessionJournal, ...args) {
      const withdrawn = await withdraw.apply(this, args)
      // Only the Stop's own withdrawal fails, after it landed; the delivery loop's pass through.
      if (args[1].rejection.kind === 'cancelled') {
        throw new Error('disk full')
      }
      return withdrawn
    })
  try {
    await expect(rig.stop()).rejects.toThrow('disk full')
  } finally {
    failing.mockRestore()
    release()
  }
  expect((await rig.submission(a))?.dispatchState).toBe('rejected')
  const before = new Set([working, a])
  await eventually(async () => {
    expect((await submissionIds()).filter((id) => !before.has(id))).toHaveLength(1)
    expect(await rig.drafts()).toEqual([])
  })
})

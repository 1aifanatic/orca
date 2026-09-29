// A Stop's queue pause dies only when a user send made after it actually starts
// a turn — the provider accepts it — never at the host's acceptance of the send.
// A consumed draft (drained or sent now) is a user send like any other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { HOST_TEST_SESSION, hostTestMessage } from './structured-agent-session-host-test-data'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  awaitUserSendTurn,
  MAX_USER_SENDS_AWAITING_TURN
} from './structured-agent-session-queued-stop'

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

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** A draft held by a Stop, with the stopped turn settled so the session is idle. */
async function stoppedDraft(): Promise<string> {
  const working = await rig.workingSend()
  const draftId = await queuedDraft('paused by stop')
  await rig.stop()
  await rig.settleAccepted(working, 'stopped')
  return draftId
}

async function handedOver(id: string): Promise<void> {
  await eventually(async () => expect((await rig.submission(id))?.handedOverAt).toBeDefined())
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

  it('a draft typed while the stopped turn winds down drains, and its turn starting lifts the older stopped cards', async () => {
    const working = await rig.workingSend()
    const olderId = await queuedDraft('held by the stop')
    await rig.stop()
    // Still winding down: the user's message becomes an unheld draft behind the stopped one.
    const typedId = await queuedDraft('typed while stopping')
    await rig.settleAccepted(working, 'stopped')
    await handedOver(typedId)
    expect(await rig.submission(olderId)).toBeUndefined()
    expect(await rig.drafts()).toEqual([{ messageId: olderId, state: 'waiting', paused: true }])
    await rig.settleAccepted(typedId, 'typed')
    await eventually(async () => expect(await rig.submission(olderId)).toBeDefined())
  })

  it("Send-now's card starting its turn lifts the other stopped cards, which drain after it", async () => {
    const working = await rig.workingSend()
    const sentId = await queuedDraft('sent now')
    const heldId = await queuedDraft('held until that turn starts')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    expect(await rig.sendNow(sentId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await handedOver(sentId)
    expect(await rig.drafts()).toEqual([{ messageId: heldId, state: 'waiting', paused: true }])
    await rig.settleAccepted(sentId, 'sent-now')
    await eventually(async () => expect(await rig.submission(heldId)).toBeDefined())
  })

  it('a consumed draft the provider refuses lifts nothing: the stopped cards stay held', async () => {
    const working = await rig.workingSend()
    const olderId = await queuedDraft('held by the stop')
    await rig.stop()
    const typedId = await queuedDraft('typed while stopping')
    await rig.settleAccepted(working, 'stopped')
    await handedOver(typedId)
    await rig.settleRejected(typedId, 'turn/start refused')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await rig.submission(olderId)).toBeUndefined()
    expect(await rig.drafts()).toContainEqual({
      messageId: olderId,
      state: 'waiting',
      paused: true
    })
  })

  it('an old send answered again after its ledger row is gone lifts nothing from a later Stop', async () => {
    const working = await rig.workingSend()
    const draftId = await queuedDraft('paused by stop')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    // The ledger forgot the id, so the send runs again and answers with its accepted submission.
    const operations = rig.store['transactions'].state.operations
    for (const [key, row] of operations) {
      if (row.operationId === working) {
        operations.delete(key)
      }
    }
    const body = hostTestMessage('work on this')
    const replayed = await rig.host.send(QUEUED_RIG_CALLER, {
      envelope: rig.envelope({ body }, 'agentSession.send', working),
      body,
      userSend: true
    })
    expect(replayed).toMatchObject({
      ok: true,
      replayed: false,
      value: { submission: { dispatchState: 'accepted' } }
    })
    // A later journal commit re-reads the remembered sends; the old one must not be among them.
    const mail = rig.send('coordinator mail', undefined, { internal: true })
    await mail.result
    await rig.settleAccepted(mail.id, 'mail')
    await expectNeverSent(draftId)
  })
})

describe('a failed Stop', () => {
  it("undoes only the holds it added: an earlier Stop's stays", async () => {
    const working = await rig.workingSend()
    const earlier = await queuedDraft('held by the first stop')
    await rig.stop()
    const fresh = await queuedDraft('typed while stopping')
    const reject = vi
      .spyOn(AgentSessionJournal.prototype, 'rejectQueuedSubmissions')
      .mockRejectedValueOnce(new Error('disk full'))
    try {
      await expect(rig.stop()).rejects.toThrow('disk full')
    } finally {
      reject.mockRestore()
    }
    expect(await rig.drafts()).toEqual([
      { messageId: earlier, state: 'waiting', paused: true },
      { messageId: fresh, state: 'waiting' }
    ])
    // The one it would have paused sends when the turn ends, as if no Stop was pressed.
    await rig.settleAccepted(working, 'working')
    await eventually(async () => expect(await rig.submission(fresh)).toBeDefined())
    expect(await rig.submission(earlier)).toBeUndefined()
  })

  it('keeps its holds when it fails after the interrupt reached the agent', async () => {
    await rig.workingSend()
    const draftId = await queuedDraft('paused by stop')
    const append = AgentSessionJournal.prototype.appendItem
    const failing = vi
      .spyOn(AgentSessionJournal.prototype, 'appendItem')
      .mockImplementation(async function (this: AgentSessionJournal, ...args) {
        // The status note written after the provider was asked to stop.
        if (args[1].kind === 'status') {
          throw new Error('disk full')
        }
        return append.apply(this, args)
      })
    try {
      await expect(rig.stop()).rejects.toThrow('disk full')
    } finally {
      failing.mockRestore()
    }
    await expectNeverSent(draftId)
  })
})

describe('user sends awaiting their turn', () => {
  it('stay bounded when they settle unknown, forgetting the oldest first', () => {
    const session = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)
    const queuedSubmission = (clientMessageId: string): AgentJournalSubmission => ({
      clientMessageId,
      fence: 1,
      payloadFingerprint: 'fp',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 0,
      resolvedAt: null,
      handoverRecorded: true
    })
    const total = MAX_USER_SENDS_AWAITING_TURN + 8
    for (let index = 0; index < total; index++) {
      awaitUserSendTurn(session, queuedSubmission(`send-${index}`))
    }
    const awaiting = [...(session?.userSendsAwaitingTurn ?? [])]
    expect(awaiting).toHaveLength(MAX_USER_SENDS_AWAITING_TURN)
    expect(awaiting[0]).toBe('send-8')
    expect(awaiting.at(-1)).toBe(`send-${total - 1}`)
  })
})

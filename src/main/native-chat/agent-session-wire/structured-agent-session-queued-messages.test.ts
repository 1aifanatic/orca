// Mid-turn queueing against the real host, store and journal: a capable send
// while the session owes work becomes a draft, the drain converts exactly one
// draft when the work settles, Stop pauses-then-withdraws with the text in the
// answer, and a refused conversion comes back as a returned card.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage,
  type AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { ConversationCommandParams } from '../../../shared/rpc-contract/structured-agent-session-params'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { rotateStructuredAgentSessionHostInstanceForTests } from './structured-agent-session-queued-pause'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let awaitStarted: Mock<NonNullable<StructuredAgentSessionAdapter['awaitStarted']>>

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-messages-'))
  resetHostTestOperationIds()
  // Admitted: the message is written and unanswered, so the session owes work
  // until the test settles it.
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  awaitStarted = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: {
      acquire: async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        acquisitionGeneration: 'generation-1',
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: 'created' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      }),
      dispatch,
      awaitStarted,
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function envelope(fields: Record<string, unknown>, method: string, clientOperationId: string) {
  return {
    sessionId: SESSION,
    clientOperationId,
    expectedRuntimeFence: 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function send(text: string, delivery?: 'queue-if-active') {
  const body = hostTestMessage(text)
  const clientOperationId = hostTestOperationId()
  const fields = { body, ...(delivery ? { delivery } : {}) }
  const result = host.send(CALLER, {
    envelope: envelope(fields, 'agentSession.send', clientOperationId),
    body,
    ...(delivery ? { delivery } : {})
  })
  return { id: clientOperationId, result }
}

function stop(withdrawQueued?: true, clientOperationId = hostTestOperationId()) {
  const fields = withdrawQueued ? { withdrawQueued } : {}
  return host.cancel(CALLER, {
    envelope: envelope(fields, 'agentSession.cancel', clientOperationId),
    ...(withdrawQueued ? { withdrawQueued } : {})
  })
}

function sendNow(messageId: string, clientOperationId = hostTestOperationId()) {
  return host.queuedMessageSend(CALLER, {
    envelope: envelope({ messageId }, 'agentSession.queuedMessageSend', clientOperationId),
    messageId
  })
}

function deleteQueued(messageId: string, clientOperationId = hostTestOperationId()) {
  return host.queuedMessageDelete(CALLER, {
    envelope: envelope({ messageId }, 'agentSession.queuedMessageDelete', clientOperationId),
    messageId
  })
}

async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

async function drafts(): Promise<{ messageId: string; state: string }[]> {
  const page = await host.history({ sessionId: SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return (page.page.queuedMessages ?? []).map(({ messageId, state, paused }) => ({
    messageId,
    state,
    ...(paused ? { paused } : {})
  }))
}

/** A first send that keeps the session working until the test settles it. */
async function workingSend(): Promise<string> {
  const { id, result } = send('work on this')
  await result
  await eventually(async () => expect((await submission(id))?.handedOverAt).toBeDefined())
  return id
}

async function settleAccepted(id: string, itemId: string): Promise<void> {
  await host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: id,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: `turn-${itemId}`, ordinal: 0 }
  })
}

async function settleRejected(id: string, reason: string): Promise<void> {
  await host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId: id,
    state: 'rejected',
    reason
  })
}

describe('accept', () => {
  it('queues a capable send while the session owes work; an ordinary send still dispatches', async () => {
    await workingSend()
    const queued = await send('queued behind', 'queue-if-active').result
    expect(queued).toMatchObject({
      ok: true,
      value: { queued: { position: 1, state: 'waiting' } }
    })
    // The draft is not a submission, feeds no reducer, and owes no work.
    expect((await host.journalSnapshot(SESSION)).submissions).toHaveLength(1)
    expect(await drafts()).toMatchObject([{ state: 'waiting' }])
  })

  it('replays the same queued answer for the same operation id', async () => {
    await workingSend()
    const body = hostTestMessage('queued behind')
    const clientOperationId = hostTestOperationId()
    const params = {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active' as const
    }
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      replayed: false,
      value: { queued: { state: 'waiting' } }
    })
    expect(await host.send(CALLER, params)).toMatchObject({
      ok: true,
      replayed: true,
      value: { queued: { state: 'waiting' } }
    })
    expect(await drafts()).toHaveLength(1)
  })

  it('routes an image send to the immediate path even while working (text-only v1)', async () => {
    await workingSend()
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'image-ref' as const, path: '/tmp/shot.png' }]
    }
    const clientOperationId = hostTestOperationId()
    const result = await host.send(CALLER, {
      envelope: envelope(
        { body, delivery: 'queue-if-active' },
        'agentSession.send',
        clientOperationId
      ),
      body,
      delivery: 'queue-if-active'
    })
    expect(result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await drafts()).toHaveLength(0)
  })

  it('a send without the delivery field never queues, whatever the session is doing', async () => {
    await workingSend()
    const { result } = send('old client send')
    expect(await result).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    expect(await drafts()).toHaveLength(0)
  })

  it('refuses past the draft-count budget with a readable message', async () => {
    await workingSend()
    for (let index = 0; index < 20; index += 1) {
      expect(await send(`draft ${index}`, 'queue-if-active').result).toMatchObject({ ok: true })
    }
    expect(await send('one too many', 'queue-if-active').result).toMatchObject({
      ok: false,
      refusal: { message: expect.stringContaining('queue is full') }
    })
  })
})

describe('drain', () => {
  it('drains a single draft when the owed work settles, and one of two drafts per settle (A1)', async () => {
    const working = await workingSend()
    const first = await send('first queued', 'queue-if-active').result
    const second = await send('second queued', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    const firstId = first.value.queued.messageId
    const secondId = second.value.queued.messageId
    await settleAccepted(working, 'a')
    // The drain converts the OLDEST actionable draft; the consumed submission
    // owes work again, which holds the second draft (one message per turn).
    await eventually(async () => expect(await submission(firstId)).toBeDefined())
    expect(await submission(secondId)).toBeUndefined()
    expect(await drafts()).toMatchObject([{ messageId: secondId, state: 'waiting' }])
    await settleAccepted(firstId, 'b')
    await eventually(async () => expect(await submission(secondId)).toBeDefined())
    expect(await drafts()).toHaveLength(0)
  })

  it('takes no serialized drain step while the session is working, then drains when the work settles', async () => {
    const working = await workingSend()
    const flush = vi.spyOn(host, 'flushStreamedEvents')
    const queued = await send('waits for the turn', 'queue-if-active').result
    await send('and another', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    // Every wake during the turn is answered by the pre-check, not a step.
    expect(flush).not.toHaveBeenCalled()
    await settleAccepted(working, 'a')
    const draftId = queued.value.queued.messageId
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
    expect(flush).toHaveBeenCalled()
  })

  it('a refused conversion returns the card with its stored reason, and an idle send overtakes a lone returned card (N1)', async () => {
    const working = await workingSend()
    const queued = await send('will be refused', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
    await settleRejected(draftId, 'provider refused this payload')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
    // The lone returned card traps nothing: a new capable send goes immediately.
    const overtaking = await send('sent past the card', 'queue-if-active').result
    expect(overtaking).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    // And the card still offers Send: a fresh submission id re-delivers it.
    const resent = await sendNow(draftId)
    expect(resent).toMatchObject({ ok: true, value: { submission: expect.anything() } })
    if (!resent.ok || !('submission' in resent.value)) {
      throw new Error('expected the submission arm')
    }
    expect(resent.value.submission.clientMessageId).not.toBe(draftId)
    expect(await drafts()).toHaveLength(0)
    // Refused again: the card returns, matched through its current submission (N4).
    await settleRejected(resent.value.submission.clientMessageId, 'refused again')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    )
  })

  it('a waiting draft behind a returned card does not drain until the card is acted on (S5)', async () => {
    const working = await workingSend()
    const first = await send('to be refused', 'queue-if-active').result
    const second = await send('waits behind the card', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    await settleAccepted(working, 'a')
    const firstId = first.value.queued.messageId
    const secondId = second.value.queued.messageId
    await eventually(async () => expect(await submission(firstId)).toBeDefined())
    await settleRejected(firstId, 'refused')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([
        { messageId: firstId, state: 'returned' },
        { messageId: secondId, state: 'waiting' }
      ])
    )
    // Deleting the card unblocks the one behind it.
    expect(await deleteQueued(firstId)).toMatchObject({ ok: true, value: { deleted: true } })
    await eventually(async () => expect(await submission(secondId)).toBeDefined())
  })
})

describe('held drafts', () => {
  it('a draft written by another host instance is held across a restart, never auto-sent', async () => {
    const working = await workingSend()
    const queued = await send('written before the restart', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    rotateStructuredAgentSessionHostInstanceForTests()
    await settleAccepted(working, 'a')
    await host.close(SESSION)
    expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'waiting', paused: true }])
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await submission(draftId)).toBeUndefined()
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
  })

  it('a failed conversion leaves the draft waiting and paused with its error; Send retries', async () => {
    const working = await workingSend()
    const queued = await send('conversion fails once', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const original = AgentSessionJournal.prototype.appendSubmission
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await settleAccepted(working, 'a')
      await eventually(async () =>
        expect(await drafts()).toMatchObject([
          { messageId: draftId, state: 'waiting', paused: true }
        ])
      )
    } finally {
      append.mockRestore()
    }
    expect(AgentSessionJournal.prototype.appendSubmission).toBe(original)
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    // A marker the client localizes, never host-authored copy.
    expect(page.ok && page.page.queuedMessages?.[0]?.pausedReason).toBe(
      QUEUED_MESSAGE_PAUSED_SEND_FAILED
    )
    expect(await submission(draftId)).toBeUndefined()
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    expect(await drafts()).toHaveLength(0)
  })
})

describe('Stop and Delete', () => {
  it('withdraws waiting and returned drafts with their text in the answer, and replays from tombstones', async () => {
    await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    const operationId = hostTestOperationId()
    const stopped = await stop(true, operationId)
    expect(stopped).toMatchObject({
      ok: true,
      value: {
        withdrawnQueued: [
          { messageId: first.value.queued.messageId, body: hostTestMessage('first text') },
          { messageId: second.value.queued.messageId, body: hostTestMessage('second text') }
        ]
      }
    })
    expect(await drafts()).toHaveLength(0)
    // A lost acknowledgement replays the same bodies from the tombstones.
    expect(await stop(true, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: {
        withdrawnQueued: [
          { messageId: first.value.queued.messageId },
          { messageId: second.value.queued.messageId }
        ]
      }
    })
  })

  /** A draft consumed into a submission the delivery loop has not handed over:
   *  the loop is held at the child's start proof until the returned release. */
  async function consumedButNotHandedOver(): Promise<{ draftId: string; release: () => void }> {
    const working = await workingSend()
    const queued = await send('stopped in flight', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    let release: () => void = () => undefined
    awaitStarted.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    )
    await settleAccepted(working, 'a')
    const draftId = queued.value.queued.messageId
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
    expect((await submission(draftId))?.handedOverAt).toBeUndefined()
    return { draftId, release: () => release() }
  }

  it("a capable Stop between consume and the agent's receipt hands the text back once, and replays it", async () => {
    const { draftId, release } = await consumedButNotHandedOver()
    const operationId = hostTestOperationId()
    const stopped = await stop(true, operationId)
    release()
    expect(stopped).toMatchObject({
      ok: true,
      value: {
        withdrawnQueued: [{ messageId: draftId, body: hostTestMessage('stopped in flight') }]
      }
    })
    if (!stopped.ok) {
      throw new Error('stop refused')
    }
    expect(stopped.value.withdrawnQueued).toHaveLength(1)
    expect(await drafts()).toHaveLength(0)
    expect((await submission(draftId))?.dispatchState).toBe('rejected')
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(await stop(true, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: {
        withdrawnQueued: [{ messageId: draftId, body: hostTestMessage('stopped in flight') }]
      }
    })
  })

  it("an old client's Stop in that window leaves the text as a returned card", async () => {
    const { draftId, release } = await consumedButNotHandedOver()
    const stopped = await stop()
    release()
    expect(stopped).toMatchObject({ ok: true })
    expect(stopped.ok && 'withdrawnQueued' in stopped.value).toBe(false)
    expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'returned' }])
    const page = await host.history({ sessionId: SESSION, direction: 'tail' })
    expect(page.ok && page.page.queuedMessages?.[0]?.returnedReason).toBe(
      DISPATCH_REJECTED_CANCELLED
    )
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("an old client's Stop pauses the drafts, and the pause survives eviction and reopen", async () => {
    const working = await workingSend()
    const queued = await send('paused by stop', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    await stop()
    expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'waiting', paused: true }])
    await settleAccepted(working, 'a')
    // Evict the handle and reopen (the history read opens the conversation at
    // rest): the pause is process-level, not handle-level, so nothing drains.
    await host.close(SESSION)
    expect(await drafts()).toMatchObject([{ messageId: draftId, state: 'waiting', paused: true }])
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await submission(draftId)).toBeUndefined()
    // Send-now overrides the pause — the user acting is the release.
    expect(await sendNow(draftId)).toMatchObject({
      ok: true,
      value: { submission: expect.anything() }
    })
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
  })

  it('Delete hands back the body and answers a replay from the tombstone', async () => {
    await workingSend()
    const queued = await send('delete me', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const operationId = hostTestOperationId()
    expect(await deleteQueued(draftId, operationId)).toMatchObject({
      ok: true,
      replayed: false,
      value: { deleted: true, body: hostTestMessage('delete me') }
    })
    expect(await deleteQueued(draftId, operationId)).toMatchObject({
      ok: true,
      replayed: true,
      value: { deleted: true, body: hostTestMessage('delete me') }
    })
    // A FRESH delete of the already-withdrawn draft reports the disposition.
    expect(await deleteQueued(draftId)).toMatchObject({
      ok: true,
      value: { deleted: false, disposition: 'withdrawn' }
    })
  })
})

describe('/clear', () => {
  function clear(clientOperationId: string, withdrawQueued?: true) {
    const fields = { command: 'clear' as const, ...(withdrawQueued ? { withdrawQueued } : {}) }
    return host.conversationCommand(CALLER, {
      envelope: envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
    })
  }

  /** Two drafts paused by an old-client Stop, then the work settled so command
   *  admission has nothing pending. */
  async function pausedDrafts(): Promise<[string, string]> {
    const working = await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    await stop()
    await settleAccepted(working, 'a')
    return [first.value.queued.messageId, second.value.queued.messageId]
  }

  it('the clear schema accepts the withdraw opt-in', () => {
    const base = { envelope: envelope({}, 'agentSession.conversationCommand', 'op-schema') }
    expect(
      ConversationCommandParams.safeParse({ ...base, command: 'clear', withdrawQueued: true })
        .success
    ).toBe(true)
  })

  it("an old client's clear never withdraws text it cannot receive: the cards stay on the source", async () => {
    const [firstId, secondId] = await pausedDrafts()
    const operationId = hostTestOperationId()
    const cleared = await clear(operationId)
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    expect(cleared.ok && 'withdrawnQueued' in cleared.value).toBe(false)
    expect(await drafts()).toMatchObject([
      { messageId: firstId, state: 'waiting' },
      { messageId: secondId, state: 'waiting' }
    ])
    const replayed = await clear(operationId)
    expect(replayed).toMatchObject({ ok: true, replayed: true })
    expect(replayed.ok && 'withdrawnQueued' in replayed.value).toBe(false)
    // The superseded source never drains them; Delete still hands the text back.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await submission(firstId)).toBeUndefined()
    expect(await deleteQueued(firstId)).toMatchObject({
      ok: true,
      value: { deleted: true, body: hostTestMessage('first text') }
    })
    expect(await drafts()).toMatchObject([{ messageId: secondId, state: 'waiting' }])
  })

  it('withdraws waiting drafts from the superseded source and returns their text', async () => {
    const working = await workingSend()
    const first = await send('first text', 'queue-if-active').result
    const second = await send('second text', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    // Stop first: an old-client Stop, so the drafts stay as paused rows the
    // clear must still retire — nothing acts on a superseded source. The
    // working send settles after, so command admission has nothing pending.
    await stop()
    await settleAccepted(working, 'a')
    const operationId = hostTestOperationId()
    const cleared = await clear(operationId, true)
    if (!cleared.ok) {
      throw new Error(`clear refused: ${JSON.stringify(cleared.refusal)}`)
    }
    expect(cleared).toMatchObject({
      ok: true,
      value: {
        command: 'clear',
        state: 'completed',
        withdrawnQueued: [
          { messageId: first.value.queued.messageId, body: hostTestMessage('first text') },
          { messageId: second.value.queued.messageId, body: hostTestMessage('second text') }
        ]
      }
    })
    expect(await drafts()).toHaveLength(0)
    // A lost acknowledgement replays the bodies from the tombstones, never the ledger.
    const replayed = await clear(operationId, true)
    expect(replayed).toMatchObject({
      ok: true,
      replayed: true,
      value: { withdrawnQueued: [{ body: hostTestMessage('first text') }, expect.anything()] }
    })
    expect(replayed.ok && replayed.value.withdrawnQueued).toHaveLength(2)
  })
  it('a clear with no drafts answers exactly as before: no withdrawnQueued field', async () => {
    const cleared = await clear(hostTestOperationId(), true)
    expect(cleared).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    expect(cleared.ok && 'withdrawnQueued' in cleared.value).toBe(false)
  })
})

describe('publication', () => {
  async function subscribeEvents(): Promise<AgentSessionSubscribeEvent[]> {
    const events: AgentSessionSubscribeEvent[] = []
    await host.subscribe({
      id: 'subscriber-1',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    return events
  }

  function queuedFrames(events: AgentSessionSubscribeEvent[]): AgentSessionQueuedMessage[][] {
    return events.flatMap((event) =>
      event.type !== 'end' && event.queuedMessages !== undefined && event.queuedMessages !== null
        ? [event.queuedMessages]
        : []
    )
  }

  it('hydrates the list on subscribe, publishes draft inserts at an unchanged cursor, and carries the shrunk list with the consumed submission in one frame', async () => {
    const working = await workingSend()
    const events = await subscribeEvents()
    // Hydration: the opening snapshot carries the (empty) list.
    expect(events[0]).toMatchObject({ type: 'snapshot', queuedMessages: [] })
    const queued = await send('queued behind', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    // The insert writes no journal row, yet the caught-up publish delivers it.
    await eventually(() => {
      const lists = queuedFrames(events)
      expect(lists.at(-1)).toMatchObject([{ messageId: draftId, state: 'waiting' }])
    })
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await submission(draftId)).toBeDefined())
    // The frame that carries the consumed submission also carries the shrunk list.
    const consumeFrame = events.find(
      (event) =>
        event.type === 'batch' &&
        event.batch.submissions.some((entry) => entry.clientMessageId === draftId)
    )
    expect(consumeFrame).toBeDefined()
    if (consumeFrame?.type === 'batch') {
      expect(consumeFrame.queuedMessages).toEqual([])
    }
  })

  it('a failed conversion reaches live subscribers as a paused card, with no further journal commit', async () => {
    const working = await workingSend()
    const events = await subscribeEvents()
    const queued = await send('conversion fails once', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error('expected a queued receipt')
    }
    const draftId = queued.value.queued.messageId
    const append = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
    try {
      await settleAccepted(working, 'a')
      await eventually(() =>
        expect(queuedFrames(events).at(-1)).toMatchObject([
          { messageId: draftId, paused: true, pausedReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED }
        ])
      )
    } finally {
      append.mockRestore()
    }
    // Send releases the process-level pause, which later tests' reused ids would otherwise inherit.
    expect(await sendNow(draftId)).toMatchObject({ ok: true })
  })

  it("an old client's Stop that commits no journal row still publishes the pause", async () => {
    const working = await workingSend()
    const first = await send('to be refused', 'queue-if-active').result
    const second = await send('waits behind the card', 'queue-if-active').result
    if (!first.ok || !('queued' in first.value) || !second.ok || !('queued' in second.value)) {
      throw new Error('expected queued receipts')
    }
    const firstId = first.value.queued.messageId
    const secondId = second.value.queued.messageId
    await settleAccepted(working, 'a')
    await eventually(async () => expect(await submission(firstId)).toBeDefined())
    await settleRejected(firstId, 'refused')
    await eventually(async () =>
      expect(await drafts()).toMatchObject([
        { messageId: firstId, state: 'returned' },
        { messageId: secondId, state: 'waiting' }
      ])
    )
    // Idle, nothing in flight: the Stop interrupts nothing and writes no journal row.
    const events = await subscribeEvents()
    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    await eventually(() =>
      expect(queuedFrames(events).at(-1)).toMatchObject([
        { messageId: firstId, state: 'returned' },
        { messageId: secondId, state: 'waiting', paused: true }
      ])
    )
  })

  it('an unchanged list is not re-sent on later frames', async () => {
    await workingSend()
    const events = await subscribeEvents()
    await send('queued behind', 'queue-if-active').result
    await eventually(() => expect(queuedFrames(events).length).toBeGreaterThan(0))
    const framesAfterInsert = queuedFrames(events).length
    // Another journal commit with no draft change re-sends nothing.
    const { result } = send('another working send')
    await result
    await eventually(async () => {
      const last = events.at(-1)
      expect(last?.type).toBe('batch')
    })
    expect(queuedFrames(events).length).toBe(framesAfterInsert)
  })
})

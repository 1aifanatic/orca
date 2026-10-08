// A /clear asked to wait (`delivery`) while the agent works: held as a card, answered at once, and
// run by the host itself when its turn comes — never handed to the agent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-queued-message-wire'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { structuredAgentSessionReturnedCardParts } from '../../../shared/structured-agent-session-rejection-words'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { QUEUED_CLEAR_CALLER_KEY } from './structured-conversation-clear'
import {
  QUEUED_MESSAGES_PERSON_RESERVE_BYTES,
  QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
} from './structured-agent-session-queued-published-bytes'

let rig: QueuedMessageTestRig
let replaced: ReturnType<typeof vi.fn>

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  replaced = vi.fn()
  Object.assign(rig.host.deps, { onConversationReplaced: replaced })
})

afterEach(() => rig.dispose())

function clear(
  delivery?: 'queue-if-active',
  clientOperationId = hostTestOperationId(),
  options?: { internal?: true }
) {
  const fields = { command: 'clear' as const, ...(delivery ? { delivery } : {}) }
  return {
    id: clientOperationId,
    result: rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields,
      ...(options?.internal ? {} : { userSend: true as const })
    })
  }
}

function compact(delivery?: 'queue-if-active') {
  const fields = { command: 'compact' as const, ...(delivery ? { delivery } : {}) }
  const clientOperationId = hostTestOperationId()
  return {
    id: clientOperationId,
    result: rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
    })
  }
}

async function queuedClear(): Promise<string> {
  const { id, result } = clear('queue-if-active')
  expect(await result).toMatchObject({
    ok: true,
    value: { command: 'clear', state: 'completed', queued: { messageId: id, state: 'waiting' } }
  })
  return id
}

async function queuedSend(text: string): Promise<string> {
  const sent = await rig.send(text, 'queue-if-active').result
  if (!sent.ok || !('queued' in sent.value)) {
    throw new Error('expected a queued receipt')
  }
  return sent.value.queued.messageId
}

/** The conversation the source's committed clear points at, once it has one. */
function replacementOf(sessionId = SESSION): string | undefined {
  const command = rig.store.getRecord(sessionId)?.conversationCommand
  return command?.command === 'clear' && command.phase === 'committed'
    ? command.replacementSessionId
    : undefined
}

/** The carried cards in the new chat, in order: those already sent there, then those waiting. */
async function carriedOrder(replacementId: string): Promise<string[]> {
  const sent = (await rig.host.journalSnapshot(replacementId)).submissions.flatMap((entry) =>
    entry.queuedMessageId ? [entry.queuedMessageId] : []
  )
  return [...sent, ...(await rig.drafts(replacementId)).map((card) => card.messageId)]
}

async function clearedReplacement(): Promise<string> {
  await eventually(() => expect(replacementOf()).toBeDefined())
  return replacementOf()!
}

/** Every committed /clear in the store: one per clear that ran. */
function committedClears(): number {
  return rig.store
    .listRecords()
    .filter(
      (record) =>
        record.conversationCommand?.command === 'clear' &&
        record.conversationCommand.phase === 'committed'
    ).length
}

const settleMs = () => new Promise((resolve) => setTimeout(resolve, 150))

const BACKGROUND_TASK: AgentChildWorkView = {
  id: 'child-dev',
  providerId: 'task-dev',
  kind: 'command',
  description: 'npm run dev',
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 1,
  stoppable: true,
  invocation: { invocationId: 'spawn-dev', generation: 1 }
}

describe('a /clear that waits in line', () => {
  it("uses the person's reserve when background cards fill their bound", async () => {
    await rig.workingSend()
    const backgroundRoom =
      QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
    const overhead = Buffer.byteLength(JSON.stringify(hostTestMessage('')), 'utf8')
    const background = rig.send('x'.repeat(backgroundRoom - overhead), 'queue-if-active', {
      internal: true
    })
    expect(await background.result).toMatchObject({
      ok: true,
      value: { queued: { messageId: background.id, state: 'waiting' } }
    })
    expect(
      await clear('queue-if-active', hostTestOperationId(), { internal: true }).result
    ).toMatchObject({ ok: false, refusal: { details: { reason: 'queueTooLarge' } } })
    const clearId = await queuedClear()
    expect(await rig.drafts()).toEqual([
      { messageId: background.id, state: 'waiting' },
      { messageId: clearId, state: 'waiting' }
    ])
    expect(replaced).not.toHaveBeenCalled()
  })

  it('holds the carried follow-up until the replacement agent proves its start', async () => {
    await rig.dispose()
    rig = await createQueuedMessageTestRig({ starting: true })
    Object.assign(rig.host.deps, { onConversationReplaced: replaced })
    const working = await rig.workingSend()
    await queuedClear()
    const followUp = await queuedSend('for the fresh chat')
    await rig.settleAccepted(working, 'before-clear')
    await eventually(() => expect(replacementOf()).toBeDefined())
    const replacement = replacementOf()!
    await eventually(() =>
      expect(rig.host.collaboratorsForTests().sessions.get(replacement)?.child?.phase).toBe(
        'starting'
      )
    )
    await settleMs()
    expect(rig.dispatch.mock.calls.some(([input]) => input.sessionId === replacement)).toBe(false)
    expect((await rig.host.journalSnapshot(replacement)).submissions).toEqual([
      expect.objectContaining({ queuedMessageId: followUp, dispatchState: 'pending' })
    ])
    await rig.host.handleAdapterEvent({
      type: 'started',
      sessionId: replacement,
      fence: rig.store.getRecord(replacement)!.lease.runtimeFence,
      acquisitionGeneration: 'generation-1',
      reportedOptions: { model: 'default' },
      restoreSkippedOptions: [],
      optionRevision: rig.host
        .collaboratorsForTests()
        .runtimeState.optionRevisions.current(replacement)
    })
    await eventually(() =>
      expect(
        rig.dispatch.mock.calls.filter(([input]) => input.sessionId === replacement)
      ).toHaveLength(1)
    )
    expect(replaced).toHaveBeenCalledOnce()
  })

  it('behind an unanswered message: a card at once; nothing is stopped or cleared yet', async () => {
    await rig.workingSend()
    const clearId = await queuedClear()
    expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'waiting' }])
    await settleMs()
    expect(replacementOf()).toBeUndefined()
    expect(rig.closeSession).not.toHaveBeenCalled()
    expect(replaced).not.toHaveBeenCalled()
  })

  it('runs on the host once the message ahead is answered: the tab moves and the source closes', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    await rig.settleAccepted(working, 'a')
    const replacementId = await clearedReplacement()
    // Recorded under the card's id: the link a reopen and a replay read.
    expect(rig.store.getRecord(SESSION)?.conversationCommand).toMatchObject({
      operationId: clearId,
      callerKey: QUEUED_CLEAR_CALLER_KEY
    })
    await eventually(() =>
      expect(replaced).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSessionId: SESSION, sessionId: replacementId })
      )
    )
    await eventually(() =>
      expect(rig.host.collaboratorsForTests().sessions.has(SESSION)).toBe(false)
    )
    expect(rig.store.getSessionTabId(SESSION)).toBeNull()
    // Never a submission: nothing names the card as its hand-off, and the agent got no "/clear".
    expect(rig.dispatch).toHaveBeenCalledOnce()
    expect(await rig.drafts()).toEqual([])
  })

  it('cards sent after it are carried to the new chat in order, unpaused, commands too', async () => {
    const working = await rig.workingSend()
    await queuedClear()
    const first = await queuedSend('first after the clear')
    const queuedCompact = compact('queue-if-active')
    expect(await queuedCompact.result).toMatchObject({ ok: true, value: { queued: {} } })
    const second = await queuedSend('second after the clear')
    await rig.settleAccepted(working, 'a')
    const replacementId = await clearedReplacement()
    // Unpaused: the first leaves for the fresh chat's agent on its own; the rest wait behind it.
    await eventually(async () => expect(await carriedOrder(replacementId)).toContain(first))
    expect(await carriedOrder(replacementId)).toEqual([first, queuedCompact.id, second])
    expect(await rig.queuePause(replacementId)).toBeNull()
    expect(await rig.drafts()).toEqual([])
  })

  it('a failed-conversion hold ahead of it or behind it keeps waiting for its own Send', async () => {
    const working = await rig.workingSend()
    const ahead = await queuedSend('failed conversion ahead of the clear')
    await queuedClear()
    const behind = await queuedSend('failed conversion behind the clear')
    const free = await queuedSend('free behind the clear')
    const queued = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal.queuedMessages
    await queued.hold({ messageIds: [ahead, behind], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
    await rig.settleAccepted(working, 'a')
    const replacementId = await clearedReplacement()
    await eventually(async () => expect(await carriedOrder(replacementId)).toContain(free))
    const carried = rig.host.collaboratorsForTests().sessions.get(replacementId)!.journal
    for (const id of [ahead, behind]) {
      expect(carried.queuedMessages.get(id)).toMatchObject({
        state: 'waiting',
        holdReason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
      })
    }
    const sent = (await rig.host.journalSnapshot(replacementId)).submissions
    expect(sent.map((entry) => entry.queuedMessageId)).toEqual([free])
  })

  it('its id resent without `delivery` is a conflict, never its card’s answer', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    expect(await clear(undefined, clearId).result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_conflict' }
    })
    expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'waiting' }])
    await rig.settleAccepted(working, 'a')
    await clearedReplacement()
    expect(committedClears()).toBe(1)
  })

  it('a resent id answers from its card, then from the clear it ran; one clear', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    expect(await clear('queue-if-active', clearId).result).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'waiting' } }
    })
    expect(await rig.drafts()).toHaveLength(1)
    await rig.settleAccepted(working, 'a')
    await clearedReplacement()
    // The original client's resend answers with the clear the queue ran: never "conversation
    // cleared", and never the card's old "waiting" receipt.
    const resent = await clear('queue-if-active', clearId).result
    expect(resent).toMatchObject({
      ok: true,
      value: { command: 'clear', state: 'completed', replacementSessionId: replacementOf() }
    })
    expect(resent.ok && resent.value.queued).toBeFalsy()
    await settleMs()
    expect(committedClears()).toBe(1)
  })

  it('a send arriving while the cleared chat closes meets the clear, not an operation in flight', async () => {
    let finishClose: () => void = () => {}
    const close = rig.host.close.bind(rig.host)
    const closing = vi.spyOn(rig.host, 'close').mockImplementation(async (sessionId, cause) => {
      await new Promise<void>((resolve) => {
        finishClose = resolve
      })
      return close(sessionId, cause)
    })
    const answer = clear().result
    await eventually(() => expect(closing).toHaveBeenCalled())
    expect(await rig.send('sent while it closes').result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    finishClose()
    expect(await answer).toMatchObject({ ok: true, value: { command: 'clear' } })
  })

  it('a new /clear pressed on the cleared chat reads as cleared, and runs nothing', async () => {
    const working = await rig.workingSend()
    await queuedClear()
    await rig.settleAccepted(working, 'a')
    await clearedReplacement()
    expect(await clear().result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    expect(committedClears()).toBe(1)
  })

  it('never steers: Send on its card mid-turn is refused and it keeps waiting', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: false,
      refusal: { message: "A command can't be sent while the agent is working." }
    })
    expect(replacementOf()).toBeUndefined()
    await rig.settleAccepted(working, 'a')
    await clearedReplacement()
  })

  it('Stop pauses it with the queue; its Send then runs the clear on the host, once', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(replacementOf()).toBeUndefined()
    const sendOp = hostTestOperationId()
    expect(await rig.sendNow(clearId, sendOp)).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'withdrawn' } }
    })
    const replacementId = await clearedReplacement()
    await eventually(() =>
      expect(replaced).toHaveBeenCalledWith(expect.objectContaining({ sessionId: replacementId }))
    )
    // The same Send asked again answers from the card; nothing clears twice.
    expect(await rig.sendNow(clearId, sendOp)).toMatchObject({
      ok: true,
      value: { queued: { messageId: clearId, state: 'withdrawn' } }
    })
    expect(committedClears()).toBe(1)
  })

  it('Delete takes it back: it never runs', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    expect(await rig.deleteQueued(clearId)).toMatchObject({ ok: true, value: { deleted: true } })
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(replacementOf()).toBeUndefined()
  })

  it('without the opt-in (an older client), is refused while a message is unanswered, as today', async () => {
    await rig.workingSend()
    expect(await clear().result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'messagesUnsettled' } }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('at rest, runs at once as before', async () => {
    const answer = await clear('queue-if-active').result
    expect(answer).toMatchObject({ ok: true, value: { command: 'clear', state: 'completed' } })
    expect(answer.ok && answer.value.queued).toBeFalsy()
    expect(answer.ok && answer.value.replacementSessionId).toBeTruthy()
    expect(replaced).toHaveBeenCalledOnce()
  })

  it('a send that races the clear is refused as cleared, with no record of it', async () => {
    const working = await rig.workingSend()
    await queuedClear()
    await rig.settleAccepted(working, 'a')
    await clearedReplacement()
    const raced = rig.send('typed as the clear ran', 'queue-if-active')
    expect(await raced.result).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'conversationCleared' } }
    })
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.submissions.some((entry) => entry.clientMessageId === raced.id)).toBe(false)
  })
})

describe('a /clear card that cannot run', () => {
  it('waits behind background tasks, unreturned, and runs by itself once they end', async () => {
    let tasks: AgentChildWorkView[] = []
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const later = await queuedSend('for the cleared chat')
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    await settleMs()
    // Still a plain waiting card: nothing failed, so nothing is said and nothing is returned.
    expect(await rig.drafts()).toEqual([
      { messageId: clearId, state: 'waiting' },
      { messageId: later, state: 'waiting' }
    ])
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.items.filter((item) => item.body.kind === 'status')).toEqual([])
    expect(await rig.handoff(later)).toBeUndefined()
    expect(replacementOf()).toBeUndefined()
    // Its Send meanwhile says why it waits, once, and changes nothing.
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: false,
      refusal: { details: { reason: 'backgroundTasksRunning' } }
    })
    expect(await rig.drafts()).toEqual([
      { messageId: clearId, state: 'waiting' },
      { messageId: later, state: 'waiting' }
    ])
    // The tasks end, as their provider reports it: the clear runs with no one pressing anything.
    tasks = []
    rig.host.publishChildWorkEvidence(SESSION, [])
    const replacementId = await clearedReplacement()
    await eventually(async () =>
      expect(
        (await rig.host.journalSnapshot(replacementId)).submissions.some(
          (entry) => entry.queuedMessageId === later
        )
      ).toBe(true)
    )
  })

  it('waits behind a handoff, and runs once the store records it ended', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const handoff = (operationId: string | null) =>
      rig.store.transitionHandoff(SESSION, (record) => ({
        ...record,
        lease: { ...record.lease, handoffOperationId: operationId }
      }))
    await handoff('op-handoff')
    await rig.settleAccepted(working, 'a')
    await settleMs()
    expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'waiting' }])
    expect(replacementOf()).toBeUndefined()
    await handoff(null)
    await clearedReplacement()
  })

  it('a clear that throws before its commit returns the card and changes nothing', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const commit = vi
      .spyOn(rig.store, 'commitConversationClearReceipt')
      .mockImplementationOnce(() => {
        throw new Error('disk full')
      })
    await rig.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'returned' }])
    )
    expect(replacementOf()).toBeUndefined()
    // What happened and what to do, naming no control: the card's Send shows only while idle.
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    const card = page.ok ? page.page.queuedMessages?.[0] : undefined
    expect(card?.returnedReason).toBe("This command didn't run. Try it again.")
    expect(
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionReturnedCardParts({
          returnedReason: card?.returnedReason ?? null,
          returnedRejection: card?.returnedRejection,
          command: true
        })
      )
    ).toBe("This command didn't run. Try it again.")
    commit.mockRestore()
    expect(await rig.sendNow(clearId)).toMatchObject({ ok: true })
    await clearedReplacement()
    expect(committedClears()).toBe(1)
  })
})

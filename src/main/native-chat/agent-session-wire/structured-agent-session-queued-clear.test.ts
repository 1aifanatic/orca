// A /clear asked to wait (`delivery`) while the agent works: held as a card, answered at once, and
// run by the host itself when its turn comes — never handed to the agent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionWriteNoticeEnglish } from '../../../shared/agent-session-refusal-notice'
import { structuredAgentSessionAttemptFailureParts } from '../../../shared/structured-agent-session-send-disposition'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { QUEUED_CLEAR_CALLER_KEY } from './structured-conversation-clear'

let rig: QueuedMessageTestRig
let replaced: ReturnType<typeof vi.fn>

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
  replaced = vi.fn()
  Object.assign(rig.host.deps, { onConversationReplaced: replaced })
})

afterEach(() => rig.dispose())

function clear(delivery?: 'queue-if-active', clientOperationId = hostTestOperationId()) {
  const fields = { command: 'clear' as const, ...(delivery ? { delivery } : {}) }
  return {
    id: clientOperationId,
    result: rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', clientOperationId),
      ...fields
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
    expect(await clear('queue-if-active', clearId).result).toMatchObject({ ok: true })
    await settleMs()
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
  it('is returned with why, said once on the card; the cards behind it wait; Send retries', async () => {
    let tasks: AgentChildWorkView[] = []
    Object.assign(rig.host.deps, {
      statusSink: { publish: () => {}, forget: () => {}, readChildWork: () => tasks }
    })
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const later = await queuedSend('for the cleared chat')
    tasks = [BACKGROUND_TASK]
    await rig.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([
        { messageId: clearId, state: 'returned' },
        { messageId: later, state: 'waiting' }
      ])
    )
    const page = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    const card = page.ok ? page.page.queuedMessages?.[0] : undefined
    expect(card?.returnedRejection).toMatchObject({
      kind: 'commandRefused',
      refusal: { details: { reason: 'backgroundTasksRunning' } }
    })
    expect(card?.returnedReason).toBe(
      'Background tasks are still running. Wait for the background tasks to finish.'
    )
    // The caption a client draws from the card's fact, with its Send beside it, says the same.
    expect(
      agentSessionWriteNoticeEnglish(
        structuredAgentSessionAttemptFailureParts(
          { kind: 'rejected', reason: card?.returnedReason ?? null },
          { retryControl: true },
          readWholeAgentSessionFailureFact(card?.returnedRejection)
        )
      )
    ).toBe('Background tasks are still running. Wait for the background tasks to finish.')
    // No status row repeats it, and the later card did not run in the uncleared chat.
    const snapshot = await rig.host.journalSnapshot(SESSION)
    expect(snapshot.items.filter((item) => item.body.kind === 'status')).toEqual([])
    expect(await rig.handoff(later)).toBeUndefined()
    expect(replacementOf()).toBeUndefined()
    // The tasks end; the card's own Send runs the clear, and the card behind goes with it.
    tasks = []
    expect(await rig.sendNow(clearId)).toMatchObject({
      ok: true,
      value: { queued: { state: 'withdrawn' } }
    })
    const replacementId = await clearedReplacement()
    await eventually(async () =>
      expect(
        (await rig.host.journalSnapshot(replacementId)).submissions.some(
          (entry) => entry.queuedMessageId === later
        )
      ).toBe(true)
    )
  })

  it('a clear that throws before its commit returns the card and changes nothing', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const commit = vi
      .spyOn(rig.store, 'commitConversationClear')
      .mockRejectedValueOnce(new Error('disk full'))
    await rig.settleAccepted(working, 'a')
    await eventually(async () =>
      expect(await rig.drafts()).toEqual([{ messageId: clearId, state: 'returned' }])
    )
    expect(replacementOf()).toBeUndefined()
    commit.mockRestore()
    expect(await rig.sendNow(clearId)).toMatchObject({ ok: true })
    await clearedReplacement()
    expect(committedClears()).toBe(1)
  })
})

describe('a crash between the clear and its carry', () => {
  it('reopening the new chat finishes the carry: the cards arrive in order, the card is settled', async () => {
    const working = await rig.workingSend()
    const clearId = await queuedClear()
    const first = await queuedSend('first after the clear')
    const second = await queuedSend('second after the clear')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // Every copy fails, as a process that dies right after the commit would leave it.
    const insert = vi
      .spyOn(JournalQueuedMessages.prototype, 'insert')
      .mockRejectedValue(new Error('crashed'))
    await rig.settleAccepted(working, 'a')
    const replacementId = await clearedReplacement()
    await settleMs()
    insert.mockRestore()
    rig.crashRestartHostProcess()
    Object.assign(rig.host.deps, { onConversationReplaced: replaced })
    // Opening the new chat re-derives the carry from the clear's record and the card it names.
    await eventually(async () => expect(await carriedOrder(replacementId)).toEqual([first, second]))
    expect(await rig.queuePause(replacementId)).toBeNull()
    const source = rig.store.listRecords().find((record) => record.sessionId === SESSION)
    expect(source?.conversationCommand?.operationId).toBe(clearId)
    expect(await rig.drafts()).toEqual([])
    expect(committedClears()).toBe(1)
  })
})

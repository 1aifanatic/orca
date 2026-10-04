// Mail for a busy structured chat waits in the chat's own queue, the one a person's message waits
// in: a card, not shown until it can say who it is from, which the queue sends when the turn ends
// counting the mail owed then, or withdraws unsent when none is. End to end on the coordinator-mail
// rig.

import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  WORKER_2_PANE,
  runtime,
  db,
  host,
  call,
  openChat,
  settleTurn,
  sendUserMessage,
  finishWorker,
  coordinatorRunAndTask,
  WAIT,
  POINTER,
  ptyPointer,
  queuedCardTexts,
  waitingCardTexts,
  turnText,
  clearChat,
  connectionFor
} from './structured-chat-coordinator-mail-rig.test-fixture'
import { formatMessagePointer } from './orchestration/formatter'
import { localOrchestrationCliCommand } from './orchestration/cli-command'
import { QueuedMessageNotConsumableError } from '../native-chat/agent-session-journal/journal-queued-messages'

/** Idle edges with nothing owed: whatever they would start gets the time to show. */
async function idleEdgesSettled(): Promise<void> {
  for (let edge = 0; edge < 3; edge += 1) {
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The person's Stop, as the chat surface sends it. */
function stopChat() {
  return host.cancel(
    { callerKey: 'test-surface' },
    {
      envelope: {
        sessionId: COORDINATOR,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: COORDINATOR,
          fields: {}
        })
      }
    }
  )
}

/** A turn the person started that is still running; resolves to its end. */
async function runningUserTurn(chat: FakeConnection): Promise<() => Promise<void>> {
  expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'turn-1' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: 'echo-go',
      clientId: chat.turns[0]!.clientUserMessageId,
      content: [{ type: 'text', text: 'go' }]
    }
  })
  await host.flushStreamedEvents(COORDINATOR)
  return async () => {
    notify('turn/completed', { turn: { id: 'turn-1' } })
    await host.flushStreamedEvents(COORDINATOR)
  }
}

describe("mail for a busy coordinator chat waits in the chat's queue", () => {
  it('holds mail that arrives mid-turn as a card in the chat queue, sent once when the turn ends', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)

    await finishWorker(taskId)
    // Not folded into the running turn: it waits in the chat's queue, like a next message.
    await vi.waitFor(
      async () =>
        expect(await waitingCardTexts(COORDINATOR)).toEqual([expect.stringMatching(POINTER)]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    // Not shown in the chat's queue until it can say who it is from.
    expect(await queuedCardTexts(COORDINATOR)).toEqual([])
    // The card records who it speaks for: the worker that sent the mail, and the Run it belongs to.
    const [card] = await host.queuedMessageRows(COORDINATOR)
    expect(card?.source).toMatchObject({
      kind: 'agent',
      senders: [{ party: { address: 'term_worker', terminalHandle: 'term_worker' } }],
      orchestration: {
        message: 'mail-notice',
        mailbox: `run:${runId}`,
        runIds: [runId]
      }
    })

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    expect(await waitingCardTexts(COORDINATOR)).toEqual([])
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('sends no card for mail the coordinator read mid-turn: the queue withdraws it unsent', async () => {
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)

    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
    // The check answers without touching the chat's queue; the card is judged when it would send.
    expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1)
    await endTurn()
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toEqual([]), WAIT)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
  })

  it('keeps one card while more mail arrives, and sends it counting all of it', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    const [card] = await host.queuedMessageRows(COORDINATOR)
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await idleEdgesSettled()
    // Neither replaced nor moved: the same card, where it was.
    expect((await host.queuedMessageRows(COORDINATOR)).map((row) => row.messageId)).toEqual([
      card!.messageId
    ])

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(
      formatMessagePointer(2, `run:${runId}`, localOrchestrationCliCommand()).trim()
    )
    // The card records what was sent: both workers and both messages.
    const [sent] = await host.queuedMessageRows(COORDINATOR)
    expect(sent?.source).toMatchObject({
      senders: [{ party: { address: 'term_worker' } }, { party: { address: 'term_worker_2' } }],
      orchestration: { messageIds: [expect.any(String), expect.any(String)] }
    })
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('sends the card queued before a Stop once the turn stops, and points later mail once', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    expect(await stopChat()).toMatchObject({ ok: true })
    await endTurn()
    // An unattended agent is not left without its mail: a person's Stop holds only their cards.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    await settleTurn(COORDINATOR, 1)

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    await settleTurn(COORDINATOR, 2)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(3)
  })

  it('/clear after a Stop: one notice for the mail, none again in the new conversation', async () => {
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    expect(await stopChat()).toMatchObject({ ok: true })
    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    // The agent reads its mail in that turn.
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })

    const successor = await clearChat(COORDINATOR)
    expect(await waitingCardTexts(successor)).toEqual([])
    expect(await sendUserMessage(successor, 'hello')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
    await settleTurn(successor, 0)
    runtime.onStructuredSessionStatusForMail({ sessionId: successor, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(connectionFor(successor).turns.map(turnText)).toEqual(['hello'])
    expect(await waitingCardTexts(successor)).toEqual([])
  })

  it('/clear moves a card still waiting: it sends once in the new conversation, and no second notice follows', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    // Every send from the old conversation loses its consume race, so the card still waits when
    // the person clears the chat.
    const journal = host.collaboratorsForTests().sessions.get(COORDINATOR)!.journal
    const [card] = await host.queuedMessageRows(COORDINATOR)
    const append = vi
      .spyOn(journal, 'appendSubmission')
      .mockRejectedValue(new QueuedMessageNotConsumableError(card!.messageId, 'waiting'))
    await endTurn()
    await vi.waitFor(() => expect(append).toHaveBeenCalled(), WAIT)
    expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1)

    const successor = await clearChat(COORDINATOR)
    append.mockRestore()
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
    expect(turnText(connectionFor(successor).turns[0]!)).toBe(ptyPointer(`run:${runId}`))
    await settleTurn(successor, 0)
    expect(await call('orchestration.check', {}, { sessionId: successor })).toMatchObject({
      count: 1
    })
    runtime.onStructuredSessionStatusForMail({ sessionId: successor, status: 'idle' })
    expect(await sendUserMessage(successor, 'hello')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(2), WAIT)
    await settleTurn(successor, 1)
    runtime.onStructuredSessionStatusForMail({ sessionId: successor, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(connectionFor(successor).turns.map(turnText)).toEqual([
      ptyPointer(`run:${runId}`),
      'hello'
    ])
    expect(await waitingCardTexts(successor)).toEqual([])
    expect(chat.turns).toHaveLength(1)
  })

  it('a notice whose send fails is not left waiting: it reaches the agent without a /clear', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    // Past the one-shot repoint that follows mail's arrival: the run is long, as when a worker
    // finishes early in the coordinator's turn.
    await new Promise((resolve) => setTimeout(resolve, 2_300))
    const journal = host.collaboratorsForTests().sessions.get(COORDINATOR)!.journal
    // The write fails only after the lane read the turn's end and saw the card still waiting, so
    // no later edge comes: the dropped card itself has to hand the mailbox back to the lane.
    const append = vi.spyOn(journal, 'appendSubmission').mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      throw new Error('disk full')
    })
    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    append.mockRestore()
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    expect(await waitingCardTexts(COORDINATOR)).toEqual([])
    expect(
      (await host.queuedMessageRows(COORDINATOR)).map(({ state, holdReason }) => [
        state,
        holdReason
      ])
    ).toEqual([['withdrawn', null]])
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('a send that keeps failing is retried once per edge, never in a loop, and nothing is held', async () => {
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    const journal = host.collaboratorsForTests().sessions.get(COORDINATOR)!.journal
    const append = vi.spyOn(journal, 'appendSubmission').mockRejectedValue(new Error('disk full'))
    await endTurn()
    await vi.waitFor(() => expect(append.mock.calls.length).toBeGreaterThanOrEqual(2), WAIT)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const settled = append.mock.calls.length
    await idleEdgesSettled()
    // At most one more attempt per idle edge.
    expect(append.mock.calls.length - settled).toBeLessThanOrEqual(3)
    append.mockRestore()
    expect(chat.turns).toHaveLength(1)
    expect(await waitingCardTexts(COORDINATOR)).toEqual([])
  })

  it('stamps the mail a handed-off notice carried even when the agent opens it in that turn', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    // The normal flow: the agent checks (without an ack) in the notice's own turn.
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(
      () =>
        expect(
          db.getAllMessages(`run:${runId}`, 20).map((row) => [row.read, row.delivered_at !== null])
        ).toEqual([[0, true]]),
      WAIT
    )
    // So a later conversation is not told again about mail the earlier one already opened.
    const successor = await clearChat(COORDINATOR)
    expect(await sendUserMessage(successor, 'hello')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
    await settleTurn(successor, 0)
    await call('orchestration.runCreate', { objective: 'other' }, { sessionId: successor })
    await call('orchestration.runUse', { id: runId }, { sessionId: successor })
    for (let edge = 0; edge < 3; edge += 1) {
      runtime.onStructuredSessionStatusForMail({ sessionId: successor, status: 'idle' })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(connectionFor(successor).turns.map(turnText)).toEqual(['hello'])
  })

  it('sends no card for mail an orchestration reset deleted', async () => {
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    expect(await call('orchestration.reset', { messages: true })).toMatchObject({
      reset: 'messages'
    })
    await endTurn()
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toEqual([]), WAIT)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
  })

  it("does not queue a pointer deleted by an operation again (a labelled card's Delete, from B); the next result is pointed", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await waitingCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    // The Delete a labelled card will offer; hidden for now, so its id comes from the host.
    const card = (await host.queuedMessageRows(COORDINATOR))[0]?.messageId
    expect(card).toBeDefined()

    const deleted = await host.queuedMessageDelete(
      { callerKey: 'test-surface' },
      {
        envelope: {
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.queuedMessageDelete',
            sessionId: COORDINATOR,
            fields: { messageId: card }
          })
        },
        messageId: card!
      }
    )
    expect(deleted).toMatchObject({ ok: true, value: { deleted: true } })
    await endTurn()
    // The person keeps talking to the agent: a turn that ran is no reason to point that mail again.
    expect(await sendUserMessage(COORDINATOR, 'carry on')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
    expect(await waitingCardTexts(COORDINATOR)).toEqual([])

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    expect(turnText(chat.turns[2]!)).toBe(ptyPointer(`run:${runId}`))
  })
})

// Mail for a busy structured chat waits in the chat's own queue as the message itself, a card the
// person sees beside their own, and the queue sends it when the turn ends. End to end on the
// coordinator-mail rig.

import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import { QueuedMessageNotConsumableError } from '../native-chat/agent-session-journal/journal-queued-messages'
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
  mailTurn,
  unreadMail,
  queuedCardTexts,
  turnText,
  clearChat,
  connectionFor
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** Idle edges with nothing owed: whatever they would start gets the time to show. */
async function idleEdgesSettled(sessionId = COORDINATOR): Promise<void> {
  for (let edge = 0; edge < 3; edge += 1) {
    runtime.onStructuredSessionStatusForMail({ sessionId, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A turn running in the chat; resolves to its end. */
async function runningTurn(chat: FakeConnection, index: number): Promise<() => Promise<void>> {
  await vi.waitFor(() => expect(chat.turns).toHaveLength(index + 1), WAIT)
  const notify = (method: string, params: unknown) => chat.handlers.onNotification?.(method, params)
  const turnId = `turn-${index + 1}`
  notify('turn/started', { turn: { id: turnId } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${index}`,
      clientId: chat.turns[index]!.clientUserMessageId,
      content: [{ type: 'text', text: 'echo' }]
    }
  })
  await host.flushStreamedEvents(COORDINATOR)
  return async () => {
    notify('turn/completed', { turn: { id: turnId } })
    await host.flushStreamedEvents(COORDINATOR)
  }
}

/** A turn the person started that is still running; resolves to its end. */
async function runningUserTurn(chat: FakeConnection): Promise<() => Promise<void>> {
  expect(await sendUserMessage(COORDINATOR, 'go')).toMatchObject({ ok: true })
  return runningTurn(chat, 0)
}

/** The ids of the cards the chat lists in its queue. */
async function queuedCardIds(sessionId = COORDINATOR): Promise<string[]> {
  const page = await host.history({ sessionId, direction: 'tail' })
  return page.ok ? (page.page.queuedMessages ?? []).map((card) => card.messageId) : []
}

/** The person's Delete on a card, as the chat surface sends it. */
function deleteCard(messageId: string) {
  return host.queuedMessageDelete(
    { callerKey: 'test-surface' },
    {
      envelope: {
        sessionId: COORDINATOR,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.queuedMessageDelete',
          sessionId: COORDINATOR,
          fields: { messageId }
        })
      },
      messageId
    }
  )
}

describe("mail for a busy coordinator chat waits in the chat's queue", () => {
  it('queues the message itself as a card the person sees, sent once when the turn ends, then read', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)

    await finishWorker(taskId)
    // Not folded into the running turn: it waits in the chat's queue, like a next message.
    const message = mailTurn(`run:${runId}`)
    await vi.waitFor(
      async () => expect(await queuedCardTexts(COORDINATOR)).toEqual([message]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    // The card records who it is from: the worker that sent the mail, and the Run it belongs to.
    const [card] = await host.queuedMessageRows(COORDINATOR)
    const [mail] = db.getAllMessages(`run:${runId}`)
    expect(card?.source).toEqual({
      kind: 'agent',
      senders: [
        { party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null } }
      ],
      orchestration: {
        message: 'mail',
        mailbox: `run:${runId}`,
        dispatchId: null,
        messages: [{ messageId: mail!.id, runId, from: 'term_worker' }]
      }
    })
    // Waiting is not taking: `check` still has it.
    expect(unreadMail(`run:${runId}`)).toEqual([mail!.id])

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(message)
    expect(await queuedCardTexts(COORDINATOR)).toEqual([])
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(() => expect(unreadMail(`run:${runId}`)).toEqual([]), WAIT)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 0
    })
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('never adds to a waiting card: mail arriving meanwhile goes in the next one, after it', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    const [first] = db.getAllMessages(`run:${runId}`)
    const cards = await queuedCardIds()
    const texts = await queuedCardTexts(COORDINATOR)

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await idleEdgesSettled()
    // The same card, unchanged, and no second one beside it.
    expect(await queuedCardIds()).toEqual(cards)
    expect(await queuedCardTexts(COORDINATOR)).toEqual(texts)

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(mailTurn(`run:${runId}`, first!.id))
    await settleTurn(COORDINATOR, 1)
    // The result that waited behind the card follows it as its own turn.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    const [later] = db.getAllMessages(`run:${runId}`)
    expect(turnText(chat.turns[2]!)).toBe(mailTurn(`run:${runId}`, later!.id))
    expect(turnText(chat.turns[2]!)).toMatch(/^\[message from term_worker_2\]/)
  })

  it('keeps two cards from one mailbox in the order their mail arrived', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endUserTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    await endUserTurn()
    // The first card is now the running turn; the next result queues behind it.
    const endFirstCard = await runningTurn(chat, 1)
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    expect(chat.turns).toHaveLength(2)

    await endFirstCard()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    const [later, earlier] = db.getAllMessages(`run:${runId}`)
    expect(chat.turns.slice(1).map(turnText)).toEqual([
      mailTurn(`run:${runId}`, earlier!.id),
      mailTurn(`run:${runId}`, later!.id)
    ])
  })

  it("leaves a deleted card's mail unread for `check`, and never pushes it again", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    const [declined] = db.getAllMessages(`run:${runId}`)
    const [card] = await queuedCardIds()

    expect(await deleteCard(card!)).toMatchObject({ ok: true, value: { deleted: true } })
    await endTurn()
    // The person keeps talking to the agent: a turn that ran is no reason to send that mail again.
    expect(await sendUserMessage(COORDINATOR, 'carry on')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
    expect(unreadMail(`run:${runId}`)).toEqual([declined!.id])

    // The next result is sent on its own: the declined one is not in it.
    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    const [next] = db.getAllMessages(`run:${runId}`)
    expect(turnText(chat.turns[2]!)).toBe(mailTurn(`run:${runId}`, next!.id))
    await settleTurn(COORDINATOR, 2)
    await vi.waitFor(() => expect(unreadMail(`run:${runId}`)).toEqual([declined!.id]), WAIT)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1,
      messages: [{ id: declined!.id }]
    })
  })

  it("/clear carries a waiting card into the new conversation, held like the person's until they write there", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    const message = mailTurn(`run:${runId}`)
    await vi.waitFor(
      async () => expect(await queuedCardTexts(COORDINATOR)).toEqual([message]),
      WAIT
    )
    // The card's hand-off loses its race, so it still waits when the person clears the chat.
    const journal = host.collaboratorsForTests().sessions.get(COORDINATOR)!.journal
    const [card] = await queuedCardIds()
    const handOff = vi
      .spyOn(journal, 'appendSubmission')
      .mockRejectedValue(new QueuedMessageNotConsumableError(card!, 'waiting'))
    await endTurn()
    await vi.waitFor(() => expect(handOff).toHaveBeenCalled(), WAIT)
    const successor = await clearChat(COORDINATOR)
    handOff.mockRestore()

    expect(await queuedCardTexts(successor)).toEqual([message])
    await idleEdgesSettled(successor)
    expect(unreadMail(`run:${runId}`)).toHaveLength(1)
    // The person's first message there lifts the pause; the card follows its turn.
    expect(await sendUserMessage(successor, 'hello')).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(1), WAIT)
    await settleTurn(successor, 0)
    await vi.waitFor(() => expect(connectionFor(successor).turns).toHaveLength(2), WAIT)
    expect(turnText(connectionFor(successor).turns[1]!)).toBe(message)
    await settleTurn(successor, 1)
    await vi.waitFor(() => expect(unreadMail(`run:${runId}`)).toEqual([]), WAIT)
    expect(chat.turns).toHaveLength(1)
  })
})

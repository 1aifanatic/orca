// Mail for a busy structured chat waits in the chat's own queue as the message itself, a card the
// person sees beside their own, and the queue sends it when the turn ends. End to end on the
// coordinator-mail rig.

import { describe, expect, it, vi } from 'vitest'
import { structuredAgentMailFacts } from '../native-chat/agent-session-wire/structured-agent-session-agent-mail'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { QueuedMessageNotConsumableError } from '../native-chat/agent-session-journal/journal-queued-messages'
import {
  COORDINATOR,
  PEER_CHAT,
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
import {
  deleteCard,
  idleEdgesSettled,
  queuedCardIds,
  runningTurn,
  runningUserTurn
} from './structured-chat-coordinator-mail-turns.test-fixture'

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
    const {
      cards: [card]
    } = structuredAgentMailFacts(await host.conversationJournal(COORDINATOR))
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

  it("lets the chat's own `check --wait` take a waiting card's mail at once, withdrawing the card", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    const [mail] = db.getAllMessages(`run:${runId}`)

    // A peek shows it and leaves the card.
    expect(
      await call('orchestration.check', { peek: true }, { sessionId: COORDINATOR })
    ).toMatchObject({ count: 1, messages: [{ id: mail!.id }] })
    expect(await queuedCardIds()).toHaveLength(1)

    // The guide's supervised wait, in the same turn the card waits behind: answered at once.
    const started = Date.now()
    const checked = await call(
      'orchestration.check',
      { wait: true, types: 'worker_done,escalation,question', timeoutMs: 5_000 },
      { sessionId: COORDINATOR }
    )
    expect(checked).toMatchObject({ count: 1, messages: [{ id: mail!.id }], timedOut: false })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(await queuedCardIds()).toEqual([])
    await call('orchestration.check', { ack: checked.deliveryId }, { sessionId: COORDINATOR })
    expect(unreadMail(`run:${runId}`)).toEqual([])

    await endTurn()
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
  })

  it('wakes a `check --wait` in the same turn for a worker result that arrives during it', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    const waiting = call(
      'orchestration.check',
      { wait: true, types: 'worker_done,escalation,question', timeoutMs: 5_000 },
      { sessionId: COORDINATOR }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    await finishWorker(taskId)
    const [mail] = db.getAllMessages(`run:${runId}`)
    expect(await waiting).toMatchObject({ count: 1, messages: [{ id: mail!.id }] })
    expect(await queuedCardIds()).toEqual([])
    await endTurn()
  })

  it("takes only what a direct-mailbox `check --types` reads; the rest comes in a new card's place", async () => {
    const peer = await openChat(PEER_CHAT)
    const endTurn = await runningUserTurn(peer, PEER_CHAT)
    const mailbox = `orca_session_id:${PEER_CHAT}`
    const status = db.insertMessage({ from: 'term_worker', to: mailbox, subject: 'progress' })
    const question = db.insertMessage({
      from: 'term_worker',
      to: mailbox,
      subject: 'which?',
      type: 'question'
    })
    runtime.deliverPendingMessagesForHandle(mailbox)
    await vi.waitFor(async () => expect(await queuedCardIds(PEER_CHAT)).toHaveLength(1), WAIT)

    const checked = await call(
      'orchestration.check',
      { types: 'question' },
      { sessionId: PEER_CHAT }
    )
    expect(checked).toMatchObject({ count: 1, messages: [{ id: question.id }] })
    // A waiting card is never edited: it is withdrawn, and what it still carried goes out anew.
    expect(await queuedCardIds(PEER_CHAT)).toEqual([])
    expect(unreadMail(mailbox)).toEqual([status.id])
    await endTurn()
    await vi.waitFor(() => expect(peer.turns).toHaveLength(2), WAIT)
    expect(turnText(peer.turns[1]!)).toBe(mailTurn(mailbox, status.id))
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
    // Recorded on the mail as the person deletes it, before any later pass could miss the card.
    await vi.waitFor(() => expect(db.getMessageById(declined!.id)?.delivered_at).not.toBeNull(), {
      timeout: 500
    })
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

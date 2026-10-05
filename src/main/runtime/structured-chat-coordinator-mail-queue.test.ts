import './rpc/unused-default-rpc-methods.test-fixture'
// A busy structured chat holds the orchestration pointer as a card in its own queue, sent when the
// turn ends, as it holds a message the person sends then. End to end on the coordinator-mail rig.

import { describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { operationId, type FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import {
  COORDINATOR,
  WORKER_2_PANE,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  finishWorker,
  host,
  openChat,
  ptyPointer,
  queuedCardTexts,
  runtime,
  sendUserMessage,
  settleTurn,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** The person's turn, started and still running; resolves to its end. */
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

/** Idle edges with nothing owed: whatever they would send gets the time to show. */
async function idleEdgesSettled(): Promise<void> {
  for (let edge = 0; edge < 3; edge += 1) {
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The chat surface's own mutation envelope for `method`. */
function surfaceEnvelope(method: string, fields: Record<string, unknown>) {
  return {
    sessionId: COORDINATOR,
    clientOperationId: operationId(),
    expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: COORDINATOR,
      fields
    })
  }
}

/** A second task, for a second worker result. */
async function secondTask(): Promise<string> {
  return idOf(
    (await call('orchestration.taskCreate', { spec: 'more' }, { sessionId: COORDINATOR })).task
  )
}

describe("a busy chat's orchestration pointer waits in its queue", () => {
  it('queues the pointer as a card, with who it is from, and sends it once when the turn ends', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(
      async () => expect(await queuedCardTexts()).toEqual([ptyPointer(`run:${runId}`)]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    const [card] = await host.queuedMessageRows(COORDINATOR)
    const [mail] = db.getAllMessages(`run:${runId}`)
    expect(card?.source).toEqual({
      kind: 'agent',
      senders: [
        { party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null } }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: `run:${runId}`,
        dispatchId: null,
        messages: [{ messageId: mail!.id, runId, from: 'term_worker' }]
      }
    })

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    expect(await queuedCardTexts()).toEqual([])
    await settleTurn(COORDINATOR, 1)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('queues no second pointer while one waits, and points new mail again once it is sent', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await secondTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    await finishWorker(second, { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await idleEdgesSettled()
    expect(await queuedCardTexts()).toEqual([ptyPointer(`run:${runId}`)])

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    // Mail that came while the card waited, and mail after it was sent: pointed again, as a
    // terminal agent is pointed again for new unread mail.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    expect(turnText(chat.turns[2]!)).toMatch(/^You have 1 orchestration message\./)
    await settleTurn(COORDINATOR, 2)
    db.insertMessage({ from: 'term_worker_2', to: `run:${runId}`, subject: 'later', runId })
    runtime.deliverPendingMessagesForHandle(`run:${runId}`)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(4), WAIT)
  })

  it("leaves the chat's own `check` as it is: the mail stays readable, and the card stays", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    const [mail] = db.getAllMessages(`run:${runId}`)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1,
      messages: [{ id: mail!.id }]
    })
    expect(await queuedCardTexts()).toEqual([ptyPointer(`run:${runId}`)])
    await endTurn()
  })

  it('points mail that came while a card waited once the person deletes that card, with the chat idle', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await secondTask()
    await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts()).toHaveLength(1), WAIT)
    // Stop holds the card; the chat is idle.
    const stop = { turnId: 'turn-1' }
    const stopped = await host.cancel(
      { callerKey: 'test-surface' },
      { envelope: surfaceEnvelope('agentSession.cancel', stop), ...stop }
    )
    expect(stopped).toMatchObject({ ok: true })
    chat.handlers.onNotification?.('turn/completed', {
      turn: { id: 'turn-1', status: 'interrupted' }
    })
    await host.flushStreamedEvents(COORDINATOR)
    await finishWorker(second, { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    // Past the arrival repoint, which finds the card still waiting.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(chat.turns).toHaveLength(1)

    const [card] = await host.queuedMessageRows(COORDINATOR)
    const remove = { messageId: card!.messageId }
    const deleted = await host.queuedMessageDelete(
      { callerKey: 'test-surface' },
      { envelope: surfaceEnvelope('agentSession.queuedMessageDelete', remove), ...remove }
    )
    expect(deleted).toMatchObject({ ok: true, value: { deleted: true } })
    // No status change follows a delete; the card leaving the queue is what points the chat.
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), { timeout: 2_000 })
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
  }, 15_000)
})

import './rpc/unused-default-rpc-methods.test-fixture'
// Busy-chat mail remains in the durable mailbox and becomes one nudge once idle.

import { describe, expect, it, vi } from 'vitest'
import { structuredAgentSessionMessageSendMutation } from '../../shared/structured-agent-session-send-mutation'
import { operationId } from './structured-chat-coordinator-fake-codex-fixture'
import type { FakeConnection } from './structured-chat-coordinator-fake-codex-fixture'
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

/** The chat's queue as its journal stores it. */
function queuedRows() {
  return host.collaboratorsForTests().sessions.get(COORDINATOR)?.journal.queuedMessages.list() ?? []
}

/** A second task, for a second worker result. */
async function secondTask(): Promise<string> {
  return idOf(
    (await call('orchestration.taskCreate', { spec: 'more' }, { sessionId: COORDINATOR })).task
  )
}

describe("a busy chat's orchestration mail waits in its mailbox", () => {
  it('defers the pointer, with who it is from, and sends it once when the turn ends', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    const dispatchId = await finishWorker(taskId)
    // The report was accepted, so its dispatch settled before its mail was named.
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    await vi.waitFor(
      () => expect(db.getStructuredPointerOperation(`run:${runId}`)).toBeDefined(),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    expect(queuedRows()).toEqual([])
    const [mail] = db.getAllMessages(`run:${runId}`)
    const from = {
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null },
          // Named by the task of the dispatch it just finished, through the real runtime's naming.
          name: 'build it'
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: `run:${runId}`,
        dispatchId: null,
        messages: [{ messageId: mail!.id, runId, from: 'term_worker' }]
      }
    }
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(1)

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    expect(JSON.stringify(chat.turns[1])).not.toContain('term_worker')
    const sent = (await host.journalSnapshot(COORDINATOR)).items.filter(
      (item) => item.body.kind === 'message' && item.body.from
    )
    expect(sent.map((item) => item.body.kind === 'message' && item.body.from)).toEqual([from])
    expect(await queuedCardTexts()).toEqual([])
    await settleTurn(COORDINATOR, 1)
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('coalesces mail that arrives while busy into one nudge', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await secondTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(
      () => expect(db.getStructuredPointerOperation(`run:${runId}`)).toBeDefined(),
      WAIT
    )
    await finishWorker(second, { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    expect(await queuedCardTexts()).toEqual([])
    expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toHaveLength(2)

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    await settleTurn(COORDINATOR, 1)
    expect(turnText(chat.turns[1]!)).toContain('2 orchestration messages')
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
    expect(await queuedCardTexts()).toEqual([])
  })

  it("lets the chat's own check consume deferred mail without sending a stale nudge", async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(
      () => expect(db.getStructuredPointerOperation(`run:${runId}`)).toBeDefined(),
      WAIT
    )
    const [mail] = db.getAllMessages(`run:${runId}`)
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1,
      messages: [{ id: mail!.id }]
    })
    expect(await queuedCardTexts()).toEqual([])
    await endTurn()
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
  })
})

it('twenty-five automatic nudges do not consume the next human queued message', async () => {
  const chat = await openChat(COORDINATOR)
  const { runId, taskId } = await coordinatorRunAndTask()
  await runningUserTurn(chat)
  const sends = vi.spyOn(host, 'send')
  await finishWorker(taskId)
  await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(1), WAIT)
  for (let index = 0; index < 25; index += 1) {
    await call('orchestration.send', {
      from: 'term_worker',
      to: `run:${runId}`,
      subject: `mail ${index}`
    })
    await vi.waitFor(() => expect(sends).toHaveBeenCalledTimes(index + 2), WAIT)
  }
  expect(await queuedCardTexts()).toEqual([])
  expect(
    await host.send(
      { callerKey: 'test-surface' },
      {
        ...structuredAgentSessionMessageSendMutation({
          sessionId: COORDINATOR,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'human message' }]
          },
          delivery: 'queue-if-active'
        }),
        userSend: true
      }
    )
  ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
  expect(await queuedCardTexts()).toEqual(['human message'])
})

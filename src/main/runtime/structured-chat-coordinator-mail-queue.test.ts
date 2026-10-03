// Mail for a busy structured chat waits in the chat's own queue, the one a person's message waits
// in: a card the person sees, sent by the queue when the turn ends, withdrawn once the mail is read,
// and not queued again once the person deleted it. End to end on the coordinator-mail rig.

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
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'

/** Idle edges with nothing owed: whatever they would start gets the time to show. */
async function idleEdgesSettled(): Promise<void> {
  for (let edge = 0; edge < 3; edge += 1) {
    runtime.onStructuredSessionStatusForMail({ sessionId: COORDINATOR, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
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
    // Not folded into the running turn: the person sees it waiting, like their own next message.
    await vi.waitFor(
      async () =>
        expect(await queuedCardTexts(COORDINATOR)).toEqual([expect.stringMatching(POINTER)]),
      WAIT
    )
    expect(chat.turns).toHaveLength(1)
    // The card records who it speaks for: the worker that sent the mail, and the Run it belongs to.
    const [card] = await host.queuedMessageRows(COORDINATOR)
    expect(card?.source).toMatchObject({
      kind: 'agent',
      message: 'mail-notice',
      senders: [
        { party: { address: 'term_worker', terminalHandle: 'term_worker' }, hostId: 'local' }
      ],
      orchestration: { mailbox: `run:${runId}`, runIds: [runId] }
    })

    await endTurn()
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)
    expect(turnText(chat.turns[1]!)).toBe(ptyPointer(`run:${runId}`))
    expect(await queuedCardTexts(COORDINATOR)).toEqual([])
    await settleTurn(COORDINATOR, 1)
    await vi.waitFor(
      () => expect(db.getUndeliveredUnreadMessages(`run:${runId}`, undefined, {})).toEqual([]),
      WAIT
    )
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(2)
  })

  it('withdraws a queued pointer once the coordinator reads that mail mid-turn', async () => {
    const chat = await openChat(COORDINATOR)
    const { taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts(COORDINATOR)).toHaveLength(1), WAIT)

    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1
    })
    // Gone before the check answers, so the turn ending next cannot send it.
    expect(await queuedCardTexts(COORDINATOR)).toEqual([])
    await endTurn()
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
  })

  it('does not queue a pointer the person deleted again; the next result is pointed', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardTexts(COORDINATOR)).toHaveLength(1), WAIT)
    const page = await host.history({ sessionId: COORDINATOR, direction: 'tail' })
    const card = page.ok ? page.page.queuedMessages?.[0]?.messageId : undefined
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
    expect(await queuedCardTexts(COORDINATOR)).toEqual([])

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(3), WAIT)
    expect(turnText(chat.turns[2]!)).toBe(ptyPointer(`run:${runId}`))
  })
})

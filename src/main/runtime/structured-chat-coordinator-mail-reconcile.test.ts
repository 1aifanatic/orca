// A card only carries mail: whatever becomes of it, the mailbox still says what was read, so mail a
// card did not deliver goes again and mail it did never does. End to end on the coordinator-mail rig.

import { describe, expect, it, vi } from 'vitest'
import { structuredAgentMailFacts } from '../native-chat/agent-session-wire/structured-agent-session-agent-mail'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { idOf } from './rpc/orchestration-session-caller-test-fixture'
import { operationId, providerFaults } from './structured-chat-coordinator-fake-codex-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WORKER_2_PANE,
  db,
  host,
  call,
  codex,
  openChat,
  connectionFor,
  settleTurn,
  finishWorker,
  coordinatorRunAndTask,
  WAIT,
  mailTurn,
  unreadMail,
  queuedCardTexts,
  turnText
} from './structured-chat-coordinator-mail-rig.test-fixture'
import {
  deleteCard,
  idleEdgesSettled,
  queuedCardIds,
  runningTurn,
  runningUserTurn
} from './structured-chat-coordinator-mail-turns.test-fixture'

/** Every turn the chat's provider was given, across restarts of its app-server. */
function allTurnTexts(): string[] {
  return codex.connections.flatMap((connection) => connection.turns.map(turnText))
}

/** A card the person queues, as the chat surface sends it. */
function queuePersonCard(text: string) {
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text }]
  }
  return host.send(
    { callerKey: 'test-surface' },
    {
      envelope: {
        sessionId: COORDINATOR,
        clientOperationId: operationId(),
        expectedRuntimeFence: host.deps.store.getRecord(COORDINATOR)!.lease.runtimeFence,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: COORDINATOR,
          fields: { body, delivery: 'queue-if-active' }
        })
      },
      body,
      delivery: 'queue-if-active',
      userSend: true
    }
  )
}

describe('mail a card did not deliver', () => {
  it('goes again after a hand-off left in doubt, and `check` never hides it meanwhile', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    const [mail] = db.getAllMessages(`run:${runId}`)
    // turn/start fails as the card is handed off: its turn may or may not have started.
    providerFaults.refuseTurnStarts = 1
    await endTurn()
    await vi.waitFor(() => expect(providerFaults.turnStarts).toBe(2), WAIT)
    expect(
      await call('orchestration.check', { peek: true }, { sessionId: COORDINATOR })
    ).toMatchObject({ count: 1, messages: [{ id: mail!.id }] })

    // Pushed again, in a new card: it waits, as any message does, while that doubt keeps the chat
    // working, and the chat's own check can still take it.
    await idleEdgesSettled()
    await vi.waitFor(async () => {
      const { cards } = structuredAgentMailFacts(await host.conversationJournal(COORDINATOR))
      expect(cards.map((card) => card.state)).toEqual(['dispatched', 'waiting'])
    }, WAIT)
    expect(await queuedCardTexts(COORDINATOR)).toEqual([mailTurn(`run:${runId}`)])
    expect(await call('orchestration.check', {}, { sessionId: COORDINATOR })).toMatchObject({
      count: 1,
      messages: [{ id: mail!.id }]
    })
    expect(await queuedCardIds()).toEqual([])
  })

  it('goes again, once, when its card came back "Not sent", and later mail is not held behind it', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    const endTurn = await runningUserTurn(chat)
    void endTurn
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    const [first] = db.getAllMessages(`run:${runId}`)
    // The provider dies and cannot start again: the queue returns the card to the person.
    providerFaults.refuseStart = () => new Error('codex is not signed in')
    chat.handlers.onExit?.(new Error('app-server crashed'))
    // Returned, then withdrawn by Orca rather than left for the person to resend.
    await vi.waitFor(async () => {
      const { cards } = structuredAgentMailFacts(await host.conversationJournal(COORDINATOR))
      expect(cards.map((card) => [card.state, card.settledByOp?.split('\u0000')[0]])).toEqual([
        ['withdrawn', 'trusted-local:orchestration:mail-card']
      ])
    }, WAIT)
    providerFaults.refuseStart = null

    await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
    await idleEdgesSettled()
    // The "Not sent" result goes again, once, and the later one is not held behind it.
    await vi.waitFor(() => expect(connectionFor(COORDINATOR).turns).toHaveLength(1), WAIT)
    expect(turnText(connectionFor(COORDINATOR).turns[0]!)).toContain(first!.id)
    await settleTurn(COORDINATOR, 0)
    await vi.waitFor(async () => {
      const { turns } = connectionFor(COORDINATOR)
      if (turns.length > 1) {
        await settleTurn(COORDINATOR, turns.length - 1)
      }
      expect(unreadMail(`run:${runId}`)).toEqual([])
    }, WAIT)
    expect(await queuedCardIds()).toEqual([])
    expect(allTurnTexts().join('\n').split(first!.id)).toHaveLength(2)
  })

  it("is the next owner's once the Run moves away from the chat holding its card", async () => {
    const chat = await openChat(COORDINATOR)
    const peer = await openChat(PEER_CHAT)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    await finishWorker(taskId)
    await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
    const [mail] = db.getAllMessages(`run:${runId}`)

    await call('orchestration.runUse', { id: runId }, { sessionId: PEER_CHAT })
    await vi.waitFor(async () => expect(await queuedCardIds()).toEqual([]), WAIT)
    await vi.waitFor(
      () => expect(peer.turns.map(turnText)).toEqual([mailTurn(`run:${runId}`)]),
      WAIT
    )
    await endTurn()
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
    await runningTurn(peer, 0, PEER_CHAT).then((end) => end())
    await vi.waitFor(() => expect(unreadMail(`run:${runId}`)).toEqual([]), WAIT)
    expect(db.getMessageById(mail!.id)?.read).toBe(1)
  })

  it('goes to the idle chat at the next edge once a full queue refused it', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    const cards: string[] = []
    for (let index = 0; index < 20; index += 1) {
      const queued = await queuePersonCard(`person ${index}`)
      cards.push(queued.ok && 'queued' in queued.value ? queued.value.clientMessageId : '')
    }
    await finishWorker(taskId)
    await vi.waitFor(
      () => expect(db.getStructuredPointerOperation(`run:${runId}`)).toBeUndefined(),
      WAIT
    )
    for (const card of cards) {
      expect(await deleteCard(card)).toMatchObject({ ok: true })
    }
    await endTurn()
    await idleEdgesSettled()
    await vi.waitFor(
      () => expect(chat.turns.map(turnText)).toContain(mailTurn(`run:${runId}`)),
      WAIT
    )
  })
})

describe('mail the chat read', () => {
  it('is never sent again by a card the lane was still building while `check` ran', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const endTurn = await runningUserTurn(chat)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const realSend = host.send.bind(host)
    const held = vi.fn()
    vi.spyOn(host, 'send').mockImplementation(async (caller, params) => {
      if ('source' in params && params.source?.kind === 'agent') {
        held()
        await gate
      }
      return realSend(caller, params)
    })
    await finishWorker(taskId)
    await vi.waitFor(() => expect(held).toHaveBeenCalled(), WAIT)
    const [mail] = db.getAllMessages(`run:${runId}`)

    // The agent's own check waits for the lane, then takes the card the lane queued.
    const checking = call('orchestration.check', {}, { sessionId: COORDINATOR })
    release()
    expect(await checking).toMatchObject({ count: 1, messages: [{ id: mail!.id }] })
    expect(await queuedCardIds()).toEqual([])
    await endTurn()
    await idleEdgesSettled()
    expect(chat.turns).toHaveLength(1)
  })
})

describe('who a sent mail turn is from', () => {
  it('is recorded on the sent message itself, for a direct turn and a handed-off card, and never published', async () => {
    const chat = await openChat(COORDINATOR)
    const { runId, taskId } = await coordinatorRunAndTask()
    const second = await call(
      'orchestration.taskCreate',
      { spec: 'more' },
      { sessionId: COORDINATOR }
    )
    await finishWorker(taskId)
    await vi.waitFor(() => expect(chat.turns).toHaveLength(1), WAIT)
    await runningTurn(chat, 0).then(async (end) => {
      await finishWorker(idOf(second.task), { handle: 'term_worker_2', paneKey: WORKER_2_PANE })
      await vi.waitFor(async () => expect(await queuedCardIds()).toHaveLength(1), WAIT)
      await end()
    })
    await vi.waitFor(() => expect(chat.turns).toHaveLength(2), WAIT)

    const { sends } = structuredAgentMailFacts(await host.conversationJournal(COORDINATOR))
    const [direct, carded] = db.getAllMessages(`run:${runId}`).toReversed()
    expect(
      sends.map(({ source }) =>
        source?.orchestration.message === 'mail'
          ? source.orchestration.messages.map((message) => message.messageId)
          : null
      )
    ).toEqual([[direct!.id], [carded!.id]])
    const published = await host.journalSnapshot(COORDINATOR)
    expect(JSON.stringify(published.submissions)).not.toContain('"source"')
    expect(connectionFor(COORDINATOR)).toBe(chat)
  })
})

// The host publishes which pause holds each card and the card its queue sends next. A client
// reading its updates one at a time, as the chat does, reads one working state across a turn's end
// or a Resume and the queue's send of the next card: the working status and row, the pickers, the
// composer button and the card labels never flip in between. Where the host would refuse the send,
// it names no next card, so the chat reads idle.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import {
  projectQueuedMessageCards,
  queuedMessageCardSteers,
  queuedMessagesResumable
} from '../../../renderer/src/components/native-chat/structured-agent-session-queued-cards'
import {
  nativeChatComposerPrimaryAction,
  type NativeChatComposerPrimaryAction
} from '../../../renderer/src/components/native-chat/native-chat-composer-primary-action'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import {
  readQueuePublication,
  structuredQueueSendGate
} from './structured-agent-session-queued-publication'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active').result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** Each waiting card's published hold, by id. */
async function heldBy(): Promise<Record<string, AgentSessionQueuePause | null | undefined>> {
  const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!page.ok) {
    throw new Error('history refused')
  }
  return Object.fromEntries(
    (page.page.queuedMessages ?? []).map((card) => [card.messageId, card.heldBy])
  )
}

type ClientView = {
  /** The chat reads as working: transcript status, working row and timer, the pickers. */
  working: boolean
  /** A Stop pressed now would stop something. */
  stopLive: boolean
  /** The empty composer's primary button. */
  button: NativeChatComposerPrimaryAction
  /** Each card's Send-now reads Steer. */
  steers: boolean[]
  cards: number
  nextQueuedMessageId: string | null
}

/** Folds every published update as the chat does, one at a time, into what it shows. */
async function watchClient(): Promise<ClientView[]> {
  const views: ClientView[] = []
  const submissions = new Map<string, AgentJournalSubmission>()
  const turns = new Map<string, string>()
  let queued: AgentSessionQueuedMessage[] = []
  let queuePause: AgentSessionQueuePause | null = null
  let nextQueuedMessageId: string | null = null
  await rig.host.subscribe({
    id: 'client-view',
    sessionId: HOST_TEST_SESSION,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      const rows = event.type === 'batch' ? event.batch : event.page
      for (const submission of rows.submissions) {
        submissions.set(submission.clientMessageId, submission)
      }
      for (const item of rows.items) {
        if (item.body.kind === 'turn') {
          turns.set(item.itemId, item.body.state)
        }
      }
      if (event.queuedMessages !== undefined) {
        queued = event.queuedMessages ?? []
        queuePause = event.queuePause ?? null
        nextQueuedMessageId = event.nextQueuedMessageId ?? null
      }
      const running = [...turns].find(([, state]) => state === 'running')?.[0] ?? null
      const all = [...submissions.values()]
      const hostWorking = isStructuredAgentSessionMainAgentWorking(running, all)
      // As use-structured-agent-session.ts derives it.
      const working = hostWorking || (nextQueuedMessageId !== null && !hostWorking)
      const cards = projectQueuedMessageCards(queued, all, {
        hasPendingPrompt: false,
        queuePaused: queuePause !== null
      })
      const queueHeld = queuedMessagesResumable(cards, working)
      views.push({
        working,
        stopLive: hostWorking,
        button: nativeChatComposerPrimaryAction({
          isWorking: working,
          composerEmpty: true,
          queueHeld
        }),
        steers: cards.map((card) => queuedMessageCardSteers(card, working)),
        cards: cards.length,
        nextQueuedMessageId
      })
    }
  })
  return views
}

/** Every update in the run reads working, with Stop and Steer, and the gap update is among them. */
function expectOneWorkingRun(views: readonly ClientView[]): void {
  expect(views.filter((view) => !view.working || view.button !== 'stop')).toEqual([])
  expect(views.flatMap((view) => view.steers)).not.toContain(false)
  // Between a turn's end (or a Resume) and the queue's send: nothing in flight yet, still working.
  expect(views.some((view) => !view.stopLive && view.nextQueuedMessageId !== null)).toBe(true)
}

describe('which pause holds each card', () => {
  it("a Stop's: the card queued before it, not the one typed while it lands; Resume and Send never show as the queue sends them", async () => {
    const working = await rig.workingSend()
    const held = await queuedDraft('held by the stop')
    await rig.stop()
    const typed = await queuedDraft('typed while the stop lands')
    expect(await heldBy()).toEqual({ [held]: { reason: 'stopped' }, [typed]: null })
    const views = await watchClient()
    await rig.settleAccepted(working, 'stopped')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(typed), 'typed')
    await eventually(async () => expect(await rig.handoff(held)).toBeDefined())
    expectOneWorkingRun(views.slice())
  })

  it("a restart's: the card from before it, not one typed during Orca's own turn since; the same holds as that turn ends", async () => {
    const working = await rig.workingSend()
    const before = await queuedDraft('written before the restart')
    await rig.restartHostProcess()
    await rig.settleAccepted(working, 'a')
    const continuation = rig.send('continue where you left off', undefined, { internal: true })
    await continuation.result
    await eventually(async () =>
      expect((await rig.submission(continuation.id))?.handedOverAt).toBeDefined()
    )
    const typed = await queuedDraft('typed during the continuation')
    expect(await heldBy()).toEqual({ [before]: { reason: 'restarted' }, [typed]: null })
    const views = await watchClient()
    await rig.settleAccepted(continuation.id, 'continuation')
    await eventually(async () => expect(await rig.handoff(typed)).toBeDefined())
    expectOneWorkingRun(views.slice())
  })

  it('after Resume over held cards the chat goes from idle with Resume straight to working with Stop', async () => {
    const working = await rig.workingSend()
    const first = await queuedDraft('first')
    await queuedDraft('second')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    const views = await watchClient()
    const before = views.length
    expect(views.at(-1)).toMatchObject({ working: false, button: 'resume' })
    expect(await rig.resume()).toMatchObject({ ok: true, value: { resumed: true } })
    await eventually(async () => expect(await rig.handoff(first)).toBeDefined())
    await eventually(() => expect(views.at(-1)?.stopLive).toBe(true))
    expectOneWorkingRun(views.slice(before))
  })
})

describe("the queue's next card on a history page", () => {
  it('names the card a Resume released while the drain still waits for the session', async () => {
    const working = await rig.workingSend()
    const card = await queuedDraft('held, then released')
    await rig.stop()
    await rig.settleAccepted(working, 'stopped')
    // The Resume row is written; its adoption, and so the drain behind it, waits.
    let release: () => void = () => undefined
    const adopt = vi
      .spyOn(JournalQueuedMessages.prototype, 'adopt')
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(false))))
    const resumed = rig.resume()
    try {
      await eventually(async () => {
        const page = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
        expect(page.ok && page.page.nextQueuedMessageId).toBe(card)
      })
    } finally {
      release()
      adopt.mockRestore()
    }
    expect(await resumed).toMatchObject({ ok: true, value: { resumed: true } })
  })
})

describe('where the host would refuse the send', () => {
  /** An idle source a /clear replaced, still holding a card: a crash before the carry leaves it. */
  async function cardLeftOnAClearedSource() {
    await rig.settleAccepted(await rig.workingSend(), 'a')
    const fields = { command: 'clear' as const }
    const cleared = await rig.host.conversationCommand(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    expect(cleared).toMatchObject({ ok: true })
    const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
    if (!journal) {
      throw new Error('expected the source open')
    }
    const card = 'left-behind'
    await journal.queuedMessages.insert({
      messageId: card,
      body: hostTestMessage('left on the source'),
      fingerprint: 'fp-left-behind',
      hostInstance: structuredAgentSessionHostInstance(),
      origin: 'client'
    })
    const record = rig.store.getRecord(HOST_TEST_SESSION)
    if (!record) {
      throw new Error('expected the record')
    }
    return { card, journal, record, fence: record.lease.runtimeFence }
  }

  it('a source a /clear replaced names no next card; the same idle state with no block names it', async () => {
    const { card, journal, record, fence } = await cardLeftOnAClearedSource()
    const gate = structuredQueueSendGate(rig.store, HOST_TEST_SESSION)
    expect(readQueuePublication(journal, gate).nextQueuedMessageId).toBeNull()
    const { conversationCommand: _cleared, ...unblocked } = record
    const next = readQueuePublication(journal, () => ({ record: unblocked, fence }))
    expect(next.nextQueuedMessageId).toBe(card)
  })

  it('a rewind whose outcome is unknown names no next card', async () => {
    const { journal, record, fence } = await cardLeftOnAClearedSource()
    const { conversationCommand: _cleared, ...unblocked } = record
    const rewind = {
      operationId: hostTestOperationId(),
      callerKey: QUEUED_RIG_CALLER.callerKey,
      itemId: 'item-1',
      expectedEpoch: 'epoch-1',
      phase: 'prepared' as const,
      retained: []
    }
    const next = (gateRecord: typeof record) =>
      readQueuePublication(journal, () => ({ record: gateRecord, fence })).nextQueuedMessageId
    expect(next({ ...unblocked, rewind })).toBeNull()
    expect(next({ ...unblocked, rewind: { ...rewind, phase: 'provider-succeeded' } })).toBeNull()
    expect(next({ ...unblocked, rewind: { ...rewind, phase: 'completed' } })).not.toBeNull()
  })
})

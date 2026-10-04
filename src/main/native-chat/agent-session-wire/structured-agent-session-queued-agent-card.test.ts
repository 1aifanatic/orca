// An agent's card in a chat's queue, on the real host: not shown to the person, no pause holds it or
// traps it behind a person's held card, and its sender judges it again in the drain's own step, so
// it goes out as written, restated, or not at all.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessageSource } from '../../../shared/agent-session-message-source'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { QueuedAgentCardJudge } from './structured-agent-session-queued-agent-card'
import { queuedMessageFingerprint } from './structured-agent-session-queued-messages'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const NOTICE = 'You have 1 orchestration message.'

function mailNotice(messageIds: string[]): AgentMessageSource {
  return {
    kind: 'agent',
    senders: [],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'run:r1',
      dispatchId: null,
      runIds: ['r1'],
      messageIds
    }
  }
}

async function queued(text: string, source?: AgentMessageSource): Promise<string> {
  const result = await rig.send(
    text,
    'queue-if-active',
    source ? { internal: true, source } : undefined
  ).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('expected a queued receipt')
  }
  return result.value.queued.messageId
}

async function row(messageId: string, sessionId = SESSION) {
  return (await rig.host.queuedMessageRows(sessionId)).find((each) => each.messageId === messageId)
}

/** The text the provider was given for a card's hand-off. */
async function sentText(draftId: string): Promise<string> {
  const handOff = await rig.handoffId(draftId)
  await eventually(() =>
    expect(rig.dispatch.mock.calls.some(([input]) => input.clientMessageId === handOff)).toBe(true)
  )
  const sent = rig.dispatch.mock.calls.find(([input]) => input.clientMessageId === handOff)
  const [block] = sent?.[0].body.blocks ?? []
  return block?.type === 'text' ? block.text : ''
}

describe("the person does not see Orca's mail notice", () => {
  it("leaves it out of the published queue and its pause header; the person's card beside it shows", async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    const personCard = await queued('typed by the person')
    expect(await rig.drafts()).toEqual([{ messageId: personCard, state: 'waiting' }])
    await rig.restartHostProcess()
    expect(await rig.drafts()).toEqual([{ messageId: personCard, state: 'waiting' }])
    expect(await rig.queuePause()).toEqual({ reason: 'restarted' })
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    expect(await row(agentCard)).toMatchObject({ state: 'dispatched' })
  })

  it('withdraws one the provider refused, which no one could act on: it never waits for the person', async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    await rig.settleRejected(await rig.handoffId(agentCard), 'The provider is unavailable.')
    await eventually(async () =>
      expect(await row(agentCard)).toMatchObject({ state: 'withdrawn', settledByOp: null })
    )
    // Nothing returned blocks the person's next queued message.
    await rig.workingSend()
    const personCard = await queued('typed by the person')
    expect(await rig.drafts()).toEqual([{ messageId: personCard, state: 'waiting' }])
  })
})

describe("no pause holds an agent's card", () => {
  it("after a restart, an agent's card behind a person's paused card still sends", async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    const personCard = await queued('typed by the person')
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.restartHostProcess()
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    await rig.settleAccepted(await rig.handoffId(agentCard), 'mail')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect((await rig.handoff(agentCard))?.dispatchState).toBe('accepted')
    expect(await rig.handoff(personCard)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'restarted' })
  })

  it("after a person's Stop, an agent's card queued before it sends; the person's stays paused", async () => {
    rig = await createQueuedMessageTestRig()
    const working = await rig.workingSend()
    const personCard = await queued('typed by the person')
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    expect(await rig.handoff(personCard)).toBeUndefined()
    expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  })
})

describe('one card per agent message', () => {
  it('folds a second notice for a mailbox into the card already waiting, whoever queued it', async () => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    const first = await queued(NOTICE, mailNotice(['m1']))
    expect(await queued('You have 2 orchestration messages.', mailNotice(['m1', 'm2']))).toBe(first)
    const other: AgentMessageSource = {
      ...mailNotice(['m3']),
      orchestration: { ...mailNotice(['m3']).orchestration, mailbox: 'run:r2' }
    }
    const second = await queued(NOTICE, other)
    expect(second).not.toBe(first)
    expect(
      (await rig.host.queuedMessageRows(SESSION))
        .filter((each) => each.state === 'waiting')
        .map((each) => each.messageId)
    ).toEqual([first, second])
  })
})

describe("the drain judges an agent's card as it sends", () => {
  it('withdraws a card owed nothing, as the host, unsent', async () => {
    const judge = vi.fn<QueuedAgentCardJudge>(() => ({ kind: 'withdraw' }))
    rig = await createQueuedMessageTestRig({ agentCards: { judgeQueuedAgentCard: judge } })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.settleAccepted(working, 'a')
    // Nobody declined it: no operation's key is stamped on the withdrawal.
    await eventually(async () =>
      expect(await row(agentCard)).toMatchObject({ state: 'withdrawn', settledByOp: null })
    )
    expect(judge).toHaveBeenCalledWith({ sessionId: SESSION, source: mailNotice(['m1']) })
    expect(await rig.handoff(agentCard)).toBeUndefined()
  })

  it('sends what the card says now, and the card records what was sent', async () => {
    const restated = hostTestMessage('You have 2 orchestration messages.')
    rig = await createQueuedMessageTestRig({
      agentCards: {
        judgeQueuedAgentCard: () => ({
          kind: 'restate',
          body: restated,
          source: mailNotice(['m1', 'm2'])
        })
      }
    })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    const handOff = await rig.handoff(agentCard)
    expect(await sentText(agentCard)).toBe('You have 2 orchestration messages.')
    expect(handOff?.payloadFingerprint).toBe(queuedMessageFingerprint(SESSION, restated))
    expect(await row(agentCard)).toMatchObject({
      state: 'dispatched',
      body: restated,
      fingerprint: queuedMessageFingerprint(SESSION, restated),
      source: mailNotice(['m1', 'm2'])
    })
  })

  it('sends a card as written when its judge fails: bookkeeping never holds the queue', async () => {
    rig = await createQueuedMessageTestRig({
      agentCards: {
        judgeQueuedAgentCard: () => {
          throw new Error('The database connection is not open')
        }
      }
    })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    expect(await sentText(agentCard)).toBe(NOTICE)
  })

  it("never asks about a person's card", async () => {
    const judge = vi.fn<QueuedAgentCardJudge>(() => ({ kind: 'withdraw' }))
    rig = await createQueuedMessageTestRig({ agentCards: { judgeQueuedAgentCard: judge } })
    const working = await rig.workingSend()
    const personCard = await queued('typed by the person')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(personCard)).toBeDefined())
    expect(judge).not.toHaveBeenCalled()
  })
})

describe('/clear and an agent card', () => {
  it('moves a waiting agent card unheld, as the host: it sends in the new conversation', async () => {
    const judge = vi.fn<QueuedAgentCardJudge>(() => ({ kind: 'send' }))
    rig = await createQueuedMessageTestRig({ agentCards: { judgeQueuedAgentCard: judge } })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    const personCard = await queued('typed by the person')
    // Every send from the source loses its consume race, so the card still waits when /clear moves it.
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const append = vi
      .spyOn(journal, 'appendSubmission')
      .mockRejectedValue(new QueuedMessageNotConsumableError(agentCard, 'waiting'))
    await rig.stop()
    await rig.settleAccepted(working, 'a')
    await eventually(() => expect(append).toHaveBeenCalled())
    expect(await row(agentCard)).toMatchObject({ state: 'waiting', holdReason: null })
    const fields = { command: 'clear' as const }
    const cleared = await rig.host.conversationCommand(CALLER, {
      envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
      ...fields
    })
    append.mockRestore()
    const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
    if (!replacementId) {
      throw new Error('expected a replacement session')
    }
    // Moved, not declined: the host's own withdrawal on the source.
    expect(await row(agentCard)).toMatchObject({ state: 'withdrawn', settledByOp: null })
    expect(await row(personCard)).toMatchObject({ state: 'withdrawn', settledByOp: null })
    // The person's card waits for them; the agent's is judged in the new conversation and sends.
    expect(await row(agentCard, replacementId)).toMatchObject({ source: mailNotice(['m1']) })
    expect(await rig.queuePause(replacementId)).toEqual({ reason: 'cleared' })
    await eventually(async () =>
      expect(
        (await rig.host.journalSnapshot(replacementId)).submissions.map(
          (entry) => entry.queuedMessageId
        )
      ).toEqual([agentCard])
    )
    expect(judge).toHaveBeenCalledWith({ sessionId: replacementId, source: mailNotice(['m1']) })
  })
})

describe('a notice no one can act on never waits on anyone', () => {
  it('a notice whose send fails is withdrawn by the host, not held, and handed back to its sender', async () => {
    const dropped = vi.fn()
    rig = await createQueuedMessageTestRig({
      agentCards: {
        judgeQueuedAgentCard: () => ({ kind: 'send' }),
        onQueuedAgentCardDropped: dropped
      }
    })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
    const append = vi
      .spyOn(journal, 'appendSubmission')
      .mockRejectedValueOnce(new Error('disk full'))
    await rig.settleAccepted(working, 'a')
    await eventually(() =>
      expect(dropped).toHaveBeenCalledWith({ sessionId: SESSION, source: mailNotice(['m1']) })
    )
    append.mockRestore()
    expect(await row(agentCard)).toMatchObject({
      state: 'withdrawn',
      holdReason: null,
      settledByOp: null
    })
    expect(await rig.handoff(agentCard)).toBeUndefined()
  })

  it("a person's Stop while the agent starts on the notice withdraws it: the Stop stays stopped", async () => {
    rig = await createQueuedMessageTestRig({
      restartable: true,
      agentCards: { judgeQueuedAgentCard: () => ({ kind: 'send' }) }
    })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    await rig.restartHostProcess()
    let release: () => void = () => undefined
    rig.awaitStarted.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
    )
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
    await rig.stop()
    release()
    await eventually(async () =>
      expect(await row(agentCard)).toMatchObject({ state: 'withdrawn', settledByOp: null })
    )
    await new Promise((resolve) => setTimeout(resolve, 250))
    const handOffs = (await rig.host.journalSnapshot(SESSION)).submissions.filter(
      (entry) => entry.queuedMessageId === agentCard
    )
    expect(handOffs.map((entry) => entry.dispatchState)).toEqual(['rejected'])
  })

  it("the person's card goes before a notice queued ahead of it", async () => {
    rig = await createQueuedMessageTestRig({
      agentCards: { judgeQueuedAgentCard: () => ({ kind: 'send' }) }
    })
    const working = await rig.workingSend()
    const agentCard = await queued(NOTICE, mailNotice(['m1']))
    const personCard = await queued('typed by the person')
    await rig.settleAccepted(working, 'a')
    await eventually(async () => expect(await rig.handoff(personCard)).toBeDefined())
    expect(await rig.handoff(agentCard)).toBeUndefined()
    await rig.settleAccepted(await rig.handoffId(personCard), 'person')
    await eventually(async () => expect(await rig.handoff(agentCard)).toBeDefined())
  })
})

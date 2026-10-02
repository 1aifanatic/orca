// Nothing steers into a turn a person's Stop is ending: a card's Send-now or a send made then waits
// for the turn to end, and runs after it as its own turn. The host owns the rule, so a client of
// any version gets it.

import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

async function turn(turnId: string, clientMessageId: string, state: 'running' | 'interrupted') {
  await journal().appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 },
    {
      kind: 'turn',
      turnId,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() + 5 })
    },
    {
      fence: rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
}

function watchStatus(): () => AgentSessionStatusSummary | undefined {
  const events: AgentSessionStatusEvent[] = []
  rig.host.subscribeStatus({ id: 'list', emit: (event) => events.push(event) })
  return () => {
    for (const event of events.toReversed()) {
      if (event.type === 'status' && event.session.sessionId === HOST_TEST_SESSION) {
        return event.session
      }
      if (event.type === 'snapshot') {
        return event.sessions.find((session) => session.sessionId === HOST_TEST_SESSION)
      }
    }
    return undefined
  }
}

/** The session's lane, after every step queued on it so far, the delivery loop's included. */
async function laneDrained(): Promise<void> {
  for (let step = 0; step < 5; step += 1) {
    await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
  }
}

/** Turn `turn-1` running, a person's Stop ending it, and what was dispatched by then. */
async function stoppingTurn(options: { card?: true } = {}) {
  rig = await createQueuedMessageTestRig()
  const sent = await rig.workingSend()
  await rig.settleAccepted(sent, 'sent')
  await turn('turn-1', sent, 'running')
  const status = watchStatus()
  let cardId: string | undefined
  if (options.card) {
    await rig.send('queued card', 'queue-if-active').result
    await eventually(async () => expect(await rig.drafts()).toHaveLength(1))
    cardId = (await rig.drafts())[0]?.messageId
  }
  expect(await rig.stop()).toMatchObject({ ok: true })
  await eventually(() => expect(status()).toMatchObject({ stopping: true }))
  return { sent, status, cardId, dispatched: rig.dispatch.mock.calls.length }
}

describe("a message sent while a person's Stop ends the turn", () => {
  it.each([
    ['a queued card sent now', true],
    ['a send', false]
  ])('waits for the turn to end, then runs as its own turn: %s', async (_, fromCard) => {
    const { sent, status, cardId, dispatched } = await stoppingTurn(fromCard ? { card: true } : {})

    const result = cardId ? await rig.sendNow(cardId) : await rig.send('one more thing').result
    expect(result).toMatchObject({ ok: true })
    // Held on the host: the delivery loop has run its steps and handed nothing over.
    await laneDrained()
    const held = await rig.submission(result.ok ? result.value.clientMessageId : '')
    expect(held).toMatchObject({ dispatchState: 'pending' })
    expect(held?.handedOverAt).toBeUndefined()
    expect(rig.dispatch.mock.calls.length).toBe(dispatched)
    expect(status()).toMatchObject({ stopping: true })

    await turn('turn-1', sent, 'interrupted')

    await eventually(() => expect(rig.dispatch.mock.calls.length).toBe(dispatched + 1))
  })
})

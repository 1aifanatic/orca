// A card records who wrote it, and the queue's send of it is that author's turn: a person's card
// ends a Stop's pause, Orca's own does not. /clear carries the author with the card.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER as CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

async function queuedDraft(text: string, options?: { internal?: true }): Promise<string> {
  const queued = await rig.send(text, 'queue-if-active', options).result
  if (!queued.ok || !('queued' in queued.value)) {
    throw new Error('expected a queued receipt')
  }
  return queued.value.queued.messageId
}

/** Each stored card's id and who wrote it. */
function cardOrigins(sessionId = SESSION): [string, string][] {
  const journal = rig.host.collaboratorsForTests().sessions.get(sessionId)?.journal
  if (!journal) {
    throw new Error('no open journal')
  }
  return journal.queuedMessages.list().map((row) => [row.messageId, row.origin])
}

it("a host-authored card queues, and its drained send does not end a Stop's hold; a person's card does", async () => {
  const working = await rig.workingSend()
  const heldId = await queuedDraft('queued before the stop')
  await rig.stop()
  // Both queued while the stopped turn winds down, so the Stop holds neither.
  const mail = await sendAgentTurn({
    kind: 'structured-session',
    host: rig.host,
    sessionId: SESSION,
    callerKey: 'orchestration-1',
    turn: {
      body: hostTestMessage('coordinator mail'),
      delivery: 'queue',
      operationId: hostTestOperationId(),
      expectedRuntimeFence: 1
    }
  })
  if (mail.kind !== 'queued') {
    throw new Error('expected the mail to queue')
  }
  const typedId = await queuedDraft('typed while stopping')
  expect(cardOrigins()).toEqual([
    [heldId, 'client'],
    [mail.clientMessageId, 'host'],
    [typedId, 'client']
  ])
  await rig.settleAccepted(working, 'a')
  // Orca's card goes first, as Orca's turn: the Stop still holds the older card.
  await eventually(async () =>
    expect(await rig.handoff(mail.clientMessageId)).toMatchObject({ origin: 'host' })
  )
  await rig.settleAccepted(await rig.handoffId(mail.clientMessageId), 'b')
  expect(await rig.queuePause()).toEqual({ reason: 'stopped' })
  // The person's card is their turn: once it starts, the held card follows.
  await eventually(async () =>
    expect(await rig.handoff(typedId)).toMatchObject({ origin: 'client' })
  )
  expect(await rig.handoff(heldId)).toBeUndefined()
  await rig.settleAccepted(await rig.handoffId(typedId), 'c')
  expect(await rig.queuePause()).toBeNull()
  await eventually(async () => expect(await rig.handoff(heldId)).toBeDefined())
})

it('a card /clear carries keeps who wrote it', async () => {
  const working = await rig.workingSend()
  const typedId = await queuedDraft('typed text')
  const mailId = await queuedDraft('coordinator mail', { internal: true })
  await rig.stop()
  await rig.settleAccepted(working, 'a')
  const fields = { command: 'clear' as const }
  const cleared = await rig.host.conversationCommand(CALLER, {
    envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId()),
    ...fields
  })
  const replacementId = cleared.ok ? cleared.value.replacementSessionId : undefined
  if (!replacementId) {
    throw new Error('expected a replacement session')
  }
  expect(cardOrigins(replacementId)).toEqual([
    [typedId, 'client'],
    [mailId, 'host']
  ])
})

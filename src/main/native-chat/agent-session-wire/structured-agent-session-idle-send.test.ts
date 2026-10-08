import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())

function nudge() {
  const body = hostTestMessage('mail waiting')
  return {
    envelope: rig.envelope({ body }, 'agentSession.send', hostTestOperationId()),
    body,
    deferWhenActive: true as const
  }
}

it('defers before recording a send while working, then accepts the same id once idle', async () => {
  const working = await rig.workingSend()
  const params = nudge()
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'turnActive' } }
  })
  expect(
    rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, params.envelope.clientOperationId)
  ).toBeNull()
  expect(await rig.drafts()).toEqual([])
  await rig.settleAccepted(working, 'a')
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true })
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({ ok: true, replayed: true })
})

it('leaves a retained user card alone and lets a fresh human send proceed', async () => {
  const working = await rig.workingSend()
  await rig.send('kept text', 'queue-if-active').result
  await rig.stop()
  await rig.settleAccepted(working, 'a')
  expect(await rig.host.send(QUEUED_RIG_CALLER, nudge())).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'messagesUnsettled' } }
  })
  expect(await rig.send('human acts now').result).toMatchObject({ ok: true })
})

it('accepts human drafts exceeding the former aggregate byte budget', async () => {
  await rig.workingSend()
  const text = 'x'.repeat(60_000)
  for (let index = 0; index < 19; index += 1) {
    expect(await rig.send(text, 'queue-if-active').result).toMatchObject({ ok: true })
  }
  expect(await rig.drafts()).toHaveLength(19)
})

it('defers while a human approval is pending without recording a failed operation', async () => {
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!journal) {
    throw new Error('missing test conversation')
  }
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'approval' },
    {
      kind: 'approval',
      title: 'Approve',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  const params = nudge()
  expect(await rig.host.send(QUEUED_RIG_CALLER, params)).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'promptPending' } }
  })
  expect(
    rig.store.getOperationRow(QUEUED_RIG_CALLER.callerKey, params.envelope.clientOperationId)
  ).toBeNull()
})

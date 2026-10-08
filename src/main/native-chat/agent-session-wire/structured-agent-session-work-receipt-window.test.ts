import { afterEach, expect, it } from 'vitest'
import { AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS } from '../../../shared/agent-session-host-authority'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../../shared/agent-session-operation-ledger'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

it('allows a fresh Send after 600 settled operations over a day', async () => {
  rig = await createQueuedMessageTestRig()
  for (let index = 0; index < 600; index += 1) {
    const now = NOW - (599 - index) * 138_000
    const operationId = `${now}-e${index.toString(16).padStart(31, '0')}`
    expect(
      await rig.store.admitOperation({
        callerKey: QUEUED_RIG_CALLER.callerKey,
        operationId,
        fingerprint: 'fp-history',
        now
      })
    ).toMatchObject({ decision: 'admit' })
    await rig.store.recordOperationOutcome({
      callerKey: QUEUED_RIG_CALLER.callerKey,
      operationId,
      outcome: { status: 'succeeded', sessionId: SESSION }
    })
  }
  expect(await rig.send('fresh work after a heavy day').result).toMatchObject({ ok: true })
  await eventually(() => expect(rig?.dispatch).toHaveBeenCalledOnce())
  expect(rig.store.listOperationRows().length).toBeLessThan(512)
})

it('replays a lost Send reply inside one hour and rejects its expired retry without dispatch', async () => {
  let now = NOW
  rig = await createQueuedMessageTestRig({ now: () => now })
  const id = await rig.workingSend()
  await rig.settleAccepted(id, 'accepted-item')
  const body = hostTestMessage('work on this')
  const args = {
    envelope: rig.envelope({ body }, 'agentSession.send', id),
    body,
    userSend: true as const
  }
  now += AGENT_SESSION_SETTLED_OPERATION_REPLAY_WINDOW_MS
  expect(await rig.host.send(QUEUED_RIG_CALLER, args)).toMatchObject({
    ok: true,
    replayed: true
  })
  now += 1
  expect(await rig.host.send(QUEUED_RIG_CALLER, args)).toMatchObject({
    ok: false,
    refusal: { code: 'agent_session_operation_expired' }
  })
  expect(rig.dispatch).toHaveBeenCalledOnce()
  const history = await rig.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(history).toMatchObject({
    ok: true,
    page: {
      submissions: expect.arrayContaining([
        expect.objectContaining({ clientMessageId: id, dispatchState: 'accepted' })
      ])
    }
  })
})

it.each(['pending', 'unknown'] as const)(
  'refuses new Send under 512 %s operations while Stop and Close still succeed',
  async (status) => {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    await rig.store['transactions'].transact(({ operations: rows }) => {
      for (let index = 0; index < 512; index += 1) {
        const row = pendingAgentSessionOperationRow({
          callerKey: QUEUED_RIG_CALLER.callerKey,
          operationId: `${NOW}-e${index.toString(16).padStart(31, '0')}`,
          fingerprint: 'fp-in-flight',
          now: NOW
        })
        rows.set(agentSessionOperationKey(row.callerKey, row.operationId), {
          ...row,
          outcome: { status }
        })
      }
    })
    expect(await rig.send('blocked fresh work').result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_capacity' }
    })
    expect(rig.dispatch).toHaveBeenCalledOnce()
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(rig.cancelTurn).toHaveBeenCalledOnce()
    await rig.host.close(SESSION, 'user-close')
    expect(rig.closeSession).toHaveBeenCalledOnce()
  }
)

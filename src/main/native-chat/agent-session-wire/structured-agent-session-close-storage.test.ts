import { afterEach, expect, it, vi } from 'vitest'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from '../../runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import * as unsent from '../agent-session-journal/journal-unsent-send-hold'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  clearStructuredHostStub()
  vi.restoreAllMocks()
  await rig?.dispose()
  rig = undefined
})

it('Close stops the host and reports a failed tab-hide write', async () => {
  installStructuredHostStub()
  hostCalls.setSessionTabVisibility.mockRejectedValueOnce(new Error('visibility write failed'))
  expect(await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)).toMatchObject(
    {
      ok: false,
      error: { message: 'visibility write failed' }
    }
  )
  expect(hostCalls.close).toHaveBeenCalledExactlyOnceWith(SESSION, 'user-close')
})

it('Close reaches the host while the tab-hide write is still pending', async () => {
  installStructuredHostStub()
  let finishHide = (): void => {}
  hostCalls.setSessionTabVisibility.mockImplementationOnce(
    () => new Promise<void>((resolve) => (finishHide = resolve))
  )
  const response = call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)
  try {
    await vi.waitFor(() => expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledOnce())
    expect(hostCalls.close).toHaveBeenCalledExactlyOnceWith(SESSION, 'user-close')
  } finally {
    finishHide()
    await response
  }
  expect(await response).toMatchObject({ ok: true, result: { ok: true } })
})

it('a failed child close still attempts to hide the tab and reports the close failure', async () => {
  installStructuredHostStub()
  hostCalls.close.mockRejectedValueOnce(new Error('child close failed'))
  expect(await call('agentSession.close', { sessionId: SESSION }, STRUCTURED_CLIENT)).toMatchObject(
    {
      ok: false,
      error: { message: 'child close failed' }
    }
  )
  expect(hostCalls.setSessionTabVisibility).toHaveBeenCalledExactlyOnceWith(SESSION, false)
})

it('RPC Close ends a live provider when hiding its tab cannot persist', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  setStructuredAgentSessionHost(rig.host)
  vi.spyOn(rig.store, 'setSessionTabVisibility').mockRejectedValueOnce(
    new Error('visibility write failed')
  )
  expect(
    await call('agentSession.close', { sessionId: HOST_TEST_SESSION }, STRUCTURED_CLIENT)
  ).toMatchObject({ ok: false, error: { message: 'visibility write failed' } })
  expect(rig.closeSession).toHaveBeenCalledOnce()
  expect(rig.store.getRecord(HOST_TEST_SESSION)?.lease.ownerProcess).toBeNull()
})

it('hold-sends and reopen-marker failures still allow provider shutdown', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  await rig.send('queued', 'queue-if-active').result
  const session = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)
  if (!session) {
    throw new Error('expected attached conversation')
  }
  const hold = vi
    .spyOn(unsent, 'holdUnsentSends')
    .mockRejectedValueOnce(new Error('hold write failed'))
  const mark = vi
    .spyOn(session.journal, 'markQueueReopen')
    .mockRejectedValueOnce(new Error('marker write failed'))
  await rig.host.close(HOST_TEST_SESSION, 'user-close')
  expect(hold).toHaveBeenCalled()
  expect(mark).toHaveBeenCalled()
  expect(rig.closeSession).toHaveBeenCalledOnce()
})

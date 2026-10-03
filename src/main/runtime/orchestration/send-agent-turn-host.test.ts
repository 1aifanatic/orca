// sendAgentTurn against the real host, store and journal, so the envelope it builds has to pass the
// host's own admission: a fingerprint over other fields than the send carries is refused there.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from '../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage,
  hostTestOperationId
} from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { sendAgentTurn, type AgentTurnDelivery } from './send-agent-turn'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

function sendTurn(delivery: AgentTurnDelivery, operationId = hostTestOperationId()) {
  return sendAgentTurn({
    kind: 'structured-session',
    host: rig.host,
    sessionId: SESSION,
    callerKey: 'trusted-local:orchestration:d1',
    turn: { body: hostTestMessage('mail'), delivery, operationId, expectedRuntimeFence: 1 }
  })
}

describe('sendAgentTurn through the real host', () => {
  it('has a `queue` send held as a draft while the agent works', async () => {
    await rig.workingSend()
    await expect(sendTurn('queue')).resolves.toMatchObject({
      kind: 'queued',
      queued: { position: 1, state: 'waiting' }
    })
    expect(await rig.drafts()).toMatchObject([{ state: 'waiting' }])
  })

  it('replays a retried `queue` send instead of refusing it', async () => {
    await rig.workingSend()
    const operationId = hostTestOperationId()
    const first = await sendTurn('queue', operationId)
    await expect(sendTurn('queue', operationId)).resolves.toEqual(first)
    expect(await rig.drafts()).toHaveLength(1)
  })

  /** Settles a handed-over send as the provider taking it; the turn's wait ends on that. */
  async function sendTurnAccepted(delivery: AgentTurnDelivery) {
    const operationId = hostTestOperationId()
    const outcome = sendTurn(delivery, operationId)
    await eventually(async () =>
      expect((await rig.submission(operationId))?.handedOverAt).toBeDefined()
    )
    await rig.settleAccepted(operationId, 'mail')
    return outcome
  }

  it.each(['now', 'queue'] as const)('sends a `%s` turn to an idle agent', async (delivery) => {
    await expect(sendTurnAccepted(delivery)).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(await rig.drafts()).toEqual([])
  })

  it('has a `now` send join the running turn, never the queue', async () => {
    await rig.workingSend()
    await expect(sendTurnAccepted('now')).resolves.toMatchObject({
      kind: 'sent',
      submission: { dispatchState: 'accepted' }
    })
    expect(await rig.drafts()).toEqual([])
  })
})

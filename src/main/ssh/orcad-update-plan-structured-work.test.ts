import { expect, it } from 'vitest'
import { planOrcadUpdate } from './orcad-update-plan'
import { emptyOrcadActivationRecord } from './orcad-activation-record'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'

it('U1: automatic update defers with zero PTYs while native provider work is in flight', async () => {
  const rig = await createQueuedMessageTestRig()
  try {
    const sent = await rig.workingSend()
    expect(await rig.submission(sent)).toMatchObject({
      dispatchState: 'pending',
      handedOverAt: expect.any(Number)
    })
    expect(rig.closeSession).not.toHaveBeenCalled()
    expect(
      planOrcadUpdate({
        candidateDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] },
        record: { ...emptyOrcadActivationRecord(), active: '0.2.0+aa01' },
        candidateVersion: '0.3.0+bb01',
        census: {
          structuredWork: rig.host.serverRetirement.read(),
          liveSessions: 0,
          startedSinceActivation: 0,
          daemonProtocolVersion: 3
        }
      })
    ).toMatchObject({ action: 'defer', code: 'orcad_update_structured_work' })
  } finally {
    await rig.dispose()
  }
})

it('defers automatic updates of an older host without a structured work observation', () => {
  const input = {
    candidateDaemonProtocol: { protocolVersion: 3, previousProtocolVersions: [1, 2] },
    record: { ...emptyOrcadActivationRecord(), active: '0.2.0+aa01' },
    candidateVersion: '0.3.0+bb01',
    census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: 3 }
  }
  expect(planOrcadUpdate(input)).toMatchObject({
    action: 'defer',
    code: 'orcad_update_structured_work'
  })
  expect(planOrcadUpdate({ ...input, force: true })).toMatchObject({ action: 'proceed' })
})

import { expect, it } from 'vitest'
import { createOrcadIdleProbes } from './orcad-managed-idle-exit'
import {
  attach,
  hostTestState,
  seedApproval
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'

it('U2: managed idle exit protects with an attached provider and pending approval', async () => {
  await attach()
  const pending = await seedApproval()
  const snapshot = await hostTestState().host.journalSnapshot(HOST_TEST_SESSION)
  expect(snapshot.items.find((item) => item.itemId === pending.itemId)?.body).toMatchObject({
    kind: 'approval',
    resolution: { state: 'pending' }
  })
  const probes = createOrcadIdleProbes(
    { timeoutMs: 900_000, activationRoot: 'test-fence' },
    {
      readClientActivity: () => ({ openConnections: 0, requestsInFlight: 0, lastRequestAt: 0 }),
      listTerminals: async () => [],
      countDaemonSessions: async () => 0,
      hasDaemon: () => true,
      readStructuredWork: () => hostTestState().host.serverRetirement.read(),
      agentStates: () => [{ state: 'blocked' }],
      hasStagedMigration: () => false,
      automationsBusy: () => false,
      activationFenceExists: async () => false
    }
  )
  expect(await probes.find((probe) => probe.name === 'structured-work')?.read()).toBe('busy')
})

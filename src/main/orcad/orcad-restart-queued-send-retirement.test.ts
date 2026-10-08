import { expect, it, vi } from 'vitest'
import { createQueuedMessageTestRig } from '../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { HOST_TEST_SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { rotateStructuredAgentSessionHostInstanceForTests } from '../native-chat/agent-session-wire/structured-agent-session-queued-pause'
import { prepareOrcadStructuredWorkBoundary } from './orcad-structured-work-boundary'

it('does not let an accepted send from an exited generation pin an unattended restarted host', async () => {
  const rig = await createQueuedMessageTestRig()
  const previous = getStructuredAgentSessionHost()
  let restarted: StructuredAgentSessionHost | undefined
  try {
    rig.host.stopDelivery()
    const sent = rig.send('accepted just before the runtime crashed')
    expect(await sent.result).toMatchObject({ ok: true })
    expect(await rig.submission(sent.id)).toMatchObject({
      dispatchState: 'pending',
      handoverRecorded: true
    })
    expect((await rig.submission(sent.id))?.handedOverAt).toBeUndefined()
    expect(rig.dispatch).not.toHaveBeenCalled()
    rotateStructuredAgentSessionHostInstanceForTests()
    const store = await openTestAgentSessionRecordStore(rig.root)
    restarted = new StructuredAgentSessionHost({
      ...rig.host.deps,
      store,
      probeOwner: async () => ({ outcome: 'pid-absent' })
    })
    setStructuredAgentSessionHost(restarted)
    await prepareOrcadStructuredWorkBoundary({ ensureStructuredAgentSessionHost: async () => {} })
    expect(store.getRecord(HOST_TEST_SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'pid-absent' }
    })
    for (let sweep = 0; sweep < 3; sweep++) {
      await restarted.serverRetirement.expireUnansweredPrompts()
      await restarted.serverRetirement.observe()
    }
    const beforeOpen = restarted.serverRetirement.read()
    const commit = vi.fn(() => false)
    const admitted = restarted.serverRetirement.admitStop(commit)
    await restarted.restoreReadableSessions()
    const afterOpen = restarted.serverRetirement.read()
    expect({ beforeOpen, stopCommits: commit.mock.calls.length, admitted, afterOpen }).toEqual({
      beforeOpen: 0,
      stopCommits: 1,
      admitted: false,
      afterOpen: 0
    })
  } finally {
    setStructuredAgentSessionHost(previous)
    await restarted?.flushAllStreamedEvents()
    await rig.dispose()
  }
})

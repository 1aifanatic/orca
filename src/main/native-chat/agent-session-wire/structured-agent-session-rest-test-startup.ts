// Host startup and a crash mid-turn on a rest rig, for the startup tests.

import { restTestChat, type RestTestRig } from './structured-agent-session-rest-test-rig'

/** What host startup runs, in order, on the ids the tab list names; answers the listed chats it
 *  left to the restore after the listing. */
export async function runRestTestStartup(
  rig: RestTestRig,
  listed: readonly string[] = rig.store.getVisibleSessionTabIndex().sessionIds
): Promise<string[]> {
  await rig.host.reconcileRestartLeases()
  const background = rig.host.startup.seedStoredStatuses(listed)
  await rig.host.startup.settleOwedSessions(listed)
  await rig.host.restoreReadableSessions(background)
  return background
}

/** A chat whose turn is running when Orca dies: startup selects it to settle. */
export async function crashRestTestChatMidTurn(
  rig: RestTestRig,
  sessionId: string,
  options: { listed?: boolean } = {}
): Promise<void> {
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, ...options })
  const { providerIdentity } = await rig.adapter.dispatch.mock.results.at(-1)!.value
  await rig.host
    .collaboratorsForTests()
    .sessions.get(sessionId)!
    .journal.appendItem(
      { ...providerIdentity, ordinal: 0 },
      { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
      { fence: rig.store.getRecord(sessionId)!.lease.runtimeFence, turnScope: { kind: 'thread' } }
    )
}

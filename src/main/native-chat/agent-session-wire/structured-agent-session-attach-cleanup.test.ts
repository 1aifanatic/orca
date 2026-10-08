import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig
let logging: ReturnType<typeof recordingStructuredAgentSessionLogger>
const retired: StructuredAgentSessionHost[] = []

beforeEach(async () => {
  logging = recordingStructuredAgentSessionLogger()
  rig = await createRestTestRig({
    logger: logging.logger,
    idleSweep: { intervalMs: 3_600_000 }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(retired.splice(0).map((host) => host.flushAllStreamedEvents()))
  await rig.dispose()
})

async function crashRestart(): Promise<void> {
  retired.push(rig.host)
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({ ...rig.host.deps, store: rig.store })
  await rig.host.reconcileRestartLeases()
}

async function restartWithRunningTurn(): Promise<void> {
  expect(await rig.host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const conversation = rig.host.collaboratorsForTests().sessions.get(SESSION)!
  await conversation.journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'old', ordinal: 1 },
    { kind: 'turn', turnId: 'old', state: 'running' },
    { fence: conversation.child!.fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await crashRestart()
}

function bufferNewTurn(turnId: string): void {
  const acquire = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementationOnce(async (input) => {
    input.events?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId, ordinal: 1 },
      { kind: 'turn', turnId, state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    return acquire(input)
  })
}

async function turnStates(): Promise<Record<string, string>> {
  const snapshot = await rig.host.journalSnapshot(SESSION)
  return Object.fromEntries(
    snapshot.items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [[turn.turnId, turn.state]] : []
    })
  )
}

it.each(['SQLITE_BUSY', 'SQLITE_FULL'])(
  'starts after restart when old turn cleanup fails with %s and re-derives cleanup later',
  async (code) => {
    await restartWithRunningTurn()
    bufferNewTurn('new')
    const error = Object.assign(new Error('old turn cleanup failed'), { code })
    const append = vi.spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch')
    append.mockRejectedValueOnce(error)

    const attached = await rig.host.attach(
      CALLER,
      hostTestAttachParams(rig.store.getRecord(SESSION)!.lease.runtimeFence)
    )

    expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
    expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('ready')
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
    expect(logging.entries).toContainEqual({
      level: 'warn',
      message: "settling a gone agent's work on attach failed",
      fields: { scope: 'attach-dead-generation', sessionId: SESSION, error }
    })
    expect(await turnStates()).toEqual({ old: 'running', new: 'running' })

    await crashRestart()
    bufferNewTurn('current')
    expect(
      await rig.host.attach(
        CALLER,
        hostTestAttachParams(rig.store.getRecord(SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(await turnStates()).toEqual({
      old: 'unverifiable',
      new: 'interrupted',
      current: 'running'
    })
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(3)
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

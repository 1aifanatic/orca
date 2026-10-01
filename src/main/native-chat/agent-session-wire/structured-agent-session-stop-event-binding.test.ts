// Which turn a person's Stop that named no turn binds: only the one its stopped send opens. A Stop of
// a start that never landed stopped a send that opens no turn, and a send journaled after the Stop
// opens its own; neither is the Stop's, whatever sent it.

import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { JournalStopEvent } from '../agent-session-journal/journal-row-schema'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

const MAIL_TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-mail',
  ordinal: 999
}

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function stopEvents(): JournalStopEvent[] {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  if (!since.ok) {
    throw new Error(`expected rows, got reset ${since.reset}`)
  }
  return since.rows.flatMap((row) =>
    row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent] : []
  )
}

function childPhase() {
  return rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.child?.phase
}

function fence(): number {
  return rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1
}

function mailTurn() {
  return journal()
    .snapshot()
    .items.map((item) => readAgentJournalTurn(item.body))
    .find((turn) => turn?.turnId === 'turn-mail')
}

/** A person's Stop of a start that never landed, whose send opens no turn; then orchestration mail
 *  starts a new child, which lands and runs the mail's turn. */
async function mailTurnAfterStopOfStart(): Promise<void> {
  rig = await createQueuedMessageTestRig({ starting: true, restartable: true })
  let release: () => void = () => undefined
  rig.awaitStarted.mockImplementation(
    () => new Promise<undefined>((resolve) => (release = () => resolve(undefined)))
  )
  rig.send('work on this')
  await eventually(() => expect(childPhase()).toBe('starting'))
  expect(await rig.stop()).toMatchObject({ ok: true })
  release()
  expect(stopEvents()).toEqual([expect.objectContaining({ reason: 'user-stop' })])
  expect(stopEvents()[0]).not.toHaveProperty('turnId')
  await eventually(() => expect(childPhase()).toBeUndefined())
  rig.awaitStarted.mockImplementation(async () => undefined)
  await rig.send('mail for the worker', undefined, { internal: true }).result
  await eventually(() => expect(rig.dispatch).toHaveBeenCalled())
  await journal().appendItem(
    MAIL_TURN,
    { kind: 'turn', turnId: 'turn-mail', state: 'running', startedAt: Date.now() },
    { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

describe('a Stop of a start that never landed binds no later turn', () => {
  it("writes the host's event when it evicts the mail turn, which reads as news", async () => {
    await mailTurnAfterStopOfStart()
    let atClose: JournalStopEvent[] = []
    rig.closeSession.mockImplementationOnce(async () => {
      atClose = stopEvents()
      return true
    })

    await rig.host.close(HOST_TEST_SESSION, 'evict')

    expect(atClose.map((event) => event.reason)).toEqual(['user-stop', 'evict'])
    await rig.host.journalSnapshot(HOST_TEST_SESSION)
    expect(mailTurn()).toMatchObject({ state: 'interrupted' })
    expect(mailTurn()).not.toHaveProperty('outcome')
  })

  it('settles a crash of the mail turn on relaunch as news', async () => {
    await mailTurnAfterStopOfStart()
    const owner = fence()
    rig.crashRestartHostProcess()
    await rig.host.journalSnapshot(HOST_TEST_SESSION)

    await settleStaleStructuredAgentSessionState({
      journal: journal(),
      sessionId: HOST_TEST_SESSION,
      fence: owner + 1,
      acquisitionGeneration: 'generation-2',
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'the relaunch proved the old child gone',
        observedAt: Date.now() + 60_000,
        ownerFence: owner
      }
    })

    expect(mailTurn()).toMatchObject({ state: 'interrupted' })
    expect(mailTurn()).not.toHaveProperty('outcome')
  })
})

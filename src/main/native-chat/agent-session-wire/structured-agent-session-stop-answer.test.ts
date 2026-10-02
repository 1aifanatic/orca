// A Stop's note records what the Stop did, naming the Stop event it answers, and a turn's end reads
// it: a Stop that interrupted nothing, or one the provider declined, never makes a later end of
// the turn the person's cancellation, live or after a restart. Against the real host and journal.

import { afterEach, describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalStopNoteAnswer
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalStopAnswer } from '../../../shared/agent-session-stop-answer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  QUEUED_RIG_CALLER,
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const TURN = 'turn-1'
const CODEX_TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: TURN,
  ordinal: 999
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
/** Codex's answer to a Stop pressed before its send's turn started: no interrupt went out. */
const NOTHING_TO_INTERRUPT: AgentSessionCancelOutcome = { cancelled: false }

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function stopEventCount(): number {
  const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
  return since.ok
    ? since.rows.filter((row) => row.kind === 'tombstone' && row.stopEvent).length
    : -1
}

/** Every Stop answer the journal holds, with the text its note shows. */
function answers(): (AgentJournalStopNoteAnswer & { text: string })[] {
  return journal()
    .snapshot()
    .items.flatMap((item) => {
      const stop = readAgentJournalStopAnswer(item.body)
      return stop && item.body.kind === 'status' ? [{ ...stop, text: item.body.text }] : []
    })
}

function latestEventAt(): number | undefined {
  return journal().stopMarks.latest()?.event.at
}

/** Turn `turn-1` as Codex writes it: opened by `clientMessageId`, running or cut off. */
async function turnOpenedBy(
  clientMessageId: string,
  state: 'running' | 'interrupted'
): Promise<void> {
  const userItemId = agentJournalSubmissionKey(clientMessageId)
  await journal().appendItem(
    CODEX_TURN,
    state === 'running'
      ? { kind: 'turn', turnId: TURN, state, startedAt: Date.now(), userItemId }
      : { kind: 'turn', turnId: TURN, state, completedAt: Date.now() + 5, userItemId },
    SCOPE
  )
}

function turn() {
  return journal()
    .snapshot()
    .items.map((item) => readAgentJournalTurn(item.body))
    .find((entry) => entry?.turnId === TURN)
}

/** Orca dies with the turn unended; the relaunch proves the old child gone after the Stop. */
async function restartAndSettle(): Promise<void> {
  rig.crashRestartHostProcess()
  await rig.host.journalSnapshot(HOST_TEST_SESSION)
  await settleStaleStructuredAgentSessionState({
    journal: journal(),
    sessionId: HOST_TEST_SESSION,
    fence: 2,
    acquisitionGeneration: 'generation-2',
    deathEvidence: {
      kind: 'exit-observed',
      detail: 'the relaunch proved the old child gone',
      observedAt: Date.now() + 60_000,
      ownerFence: 1
    }
  })
}

function stopNaming(turnId: string) {
  const fields = { turnId }
  return rig.host.cancel(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.cancel', hostTestOperationId()),
    ...fields
  })
}

describe('a Stop pressed before its send opened a turn, which interrupted nothing', () => {
  /** The send is handed over and its turn has not opened; the Stop names none. */
  async function stoppedBeforeTheTurn(answer: AgentSessionCancelOutcome): Promise<string> {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    rig.cancelTurn.mockResolvedValueOnce(answer)
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    await rig.settleAccepted(stopped, 'stopped')
    await turnOpenedBy(stopped, 'running')
    return stopped
  }

  it('answers no-effect, naming the event it wrote', async () => {
    await stoppedBeforeTheTurn(NOTHING_TO_INTERRUPT)

    expect(answers()).toEqual([
      { answer: 'no-effect', eventAt: latestEventAt(), text: 'Codex had no turn running to stop.' }
    ])
  })

  it('reads the turn its send opened, cut off later, as news', async () => {
    const stopped = await stoppedBeforeTheTurn(NOTHING_TO_INTERRUPT)

    await turnOpenedBy(stopped, 'interrupted')

    expect(turn()).toMatchObject({ state: 'interrupted' })
    expect(turn()).not.toHaveProperty('outcome')
  })

  it('reads that turn as news when a restart settles it', async () => {
    await stoppedBeforeTheTurn(NOTHING_TO_INTERRUPT)

    await restartAndSettle()

    expect(turn()).toMatchObject({ state: 'interrupted' })
    expect(turn()).not.toHaveProperty('outcome')
  })

  it('reads the same turn as the cancellation once a second press of the same Stop took', async () => {
    const stopped = await stoppedBeforeTheTurn(NOTHING_TO_INTERRUPT)

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await turnOpenedBy(stopped, 'interrupted')

    // The press repeats the Stop in force: no event of its own, an answer to that one's.
    expect(stopEventCount()).toBe(1)
    expect(answers().map(({ answer, eventAt }) => ({ answer, eventAt }))).toEqual([
      { answer: 'no-effect', eventAt: latestEventAt() },
      { answer: 'took', eventAt: latestEventAt() }
    ])
    expect(turn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })
})

describe("a host stop after a person's Stop that named no turn", () => {
  /** A send handed over with no turn open, and a Stop of it the provider answered with `answer`. */
  async function stoppedUnopenedSend(answer: AgentSessionCancelOutcome): Promise<void> {
    rig = await createQueuedMessageTestRig()
    await rig.workingSend()
    rig.cancelTurn.mockResolvedValueOnce(answer)
    expect(await rig.stop()).toMatchObject({ ok: true })
  }

  /** The Stop events' reasons as the eviction's provider close finds them. */
  async function evicted(): Promise<string[]> {
    let atClose: string[] = []
    rig.closeSession.mockImplementationOnce(async () => {
      const since = journal().readSince({ epoch: journal().epoch, sequence: 0 })
      atClose = since.ok
        ? since.rows.flatMap((row) =>
            row.kind === 'tombstone' && row.stopEvent ? [row.stopEvent.reason] : []
          )
        : []
      return true
    })
    await rig.host.close(HOST_TEST_SESSION, 'evict')
    return atClose
  }

  it("defers to a Stop that took, writing nothing of the host's", async () => {
    await stoppedUnopenedSend({ cancelled: true })

    expect(await evicted()).toEqual(['user-stop'])
  })

  it('records its own event over a Stop that interrupted nothing', async () => {
    await stoppedUnopenedSend(NOTHING_TO_INTERRUPT)

    expect(await evicted()).toEqual(['user-stop', 'evict'])
  })
})

describe('a Stop of a running turn', () => {
  async function runningTurn(options: { stopEndsSession?: true } = {}): Promise<void> {
    rig = await createQueuedMessageTestRig(options)
    await rig.workingSend()
    await journal().appendItem(
      CODEX_TURN,
      { kind: 'turn', turnId: TURN, state: 'running', startedAt: Date.now() - 30_000 },
      SCOPE
    )
  }

  it('answers took when the provider took the interrupt, and its end reads as the cancellation', async () => {
    await runningTurn()

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    await restartAndSettle()

    expect(answers()).toEqual([
      { answer: 'took', eventAt: latestEventAt(), text: 'Cancellation requested.' }
    ])
    expect(turn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it('answers end-owed when the Stop ends the provider process next, whatever it answered', async () => {
    await runningTurn({ stopEndsSession: true })
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: {} })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(answers()).toEqual([
      { answer: 'end-owed', eventAt: latestEventAt(), text: 'Cancellation requested.' }
    ])
  })

  it('answers declined when the interrupt failed and the child could not be ended, and a crash reads as news', async () => {
    await runningTurn()
    rig.cancelTurn.mockResolvedValueOnce({
      cancelled: false,
      refusal: { detail: { text: 'failed to interrupt turn', audience: 'person' } }
    })
    rig.closeSession.mockResolvedValueOnce(false)

    expect(await stopNaming(TURN)).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(answers()).toEqual([
      { answer: 'declined', eventAt: latestEventAt(), text: expect.stringContaining("didn't stop") }
    ])

    await restartAndSettle()

    expect(turn()).toMatchObject({ state: 'interrupted' })
    expect(turn()).not.toHaveProperty('outcome')
  })

  it('keeps the answer that it took when the same Stop, pressed again, finds nothing to interrupt', async () => {
    await runningTurn()
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: { turnNotRunning: true } })

    await rig.stop()

    expect(stopEventCount()).toBe(1)
    expect(answers()).toEqual([
      { answer: 'took', eventAt: latestEventAt(), text: 'Cancellation requested.' }
    ])
    await restartAndSettle()
    expect(turn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })
})

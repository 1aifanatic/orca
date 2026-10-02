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

function latestEventId(): string | undefined {
  return journal().stopMarks.latest()?.event.id
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

    expect(latestEventId()).toEqual(expect.any(String))
    expect(answers()).toEqual([
      { answer: 'no-effect', eventId: latestEventId(), text: 'Codex had no turn running to stop.' }
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
    expect(answers().map(({ answer, eventId }) => ({ answer, eventId }))).toEqual([
      { answer: 'no-effect', eventId: latestEventId() },
      { answer: 'took', eventId: latestEventId() }
    ])
    expect(turn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })
})

describe("an eviction after a person's Stop that named no turn", () => {
  /** A send handed over with no turn open, a card queued behind it, and a Stop of that send the
   *  provider answered with `answer`; the card's id. */
  async function stoppedUnopenedSend(answer: AgentSessionCancelOutcome): Promise<string> {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    const queued = await rig.send('then this', 'queue-if-active').result
    if (!queued.ok || !('queued' in queued.value)) {
      throw new Error(`expected a queued receipt: ${JSON.stringify(queued)}`)
    }
    rig.cancelTurn.mockResolvedValueOnce(answer)
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(await rig.queuePause()).toMatchObject({ reason: 'stopped' })
    stoppedSend = sent
    return queued.value.queued.messageId
  }
  let stoppedSend = ''

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

  // The latest Stop is what holds the person's pause, so the host never writes over theirs.
  it.each([
    ['took', { cancelled: true }],
    ['interrupted nothing', NOTHING_TO_INTERRUPT]
  ] as const)(
    "defers to a Stop that %s, so the person's pause still holds the card queued before it",
    async (_case, answer) => {
      const card = await stoppedUnopenedSend(answer)

      expect(await evicted()).toEqual(['user-stop'])

      expect(await rig.queuePause()).toMatchObject({ reason: 'stopped' })
      expect(await rig.drafts()).toEqual([{ messageId: card, state: 'waiting' }])
      expect(await rig.handoff(card)).toBeUndefined()
    }
  )

  it('defers to a Stop that interrupted nothing once its send opened a turn, and that turn still ends as news', async () => {
    const card = await stoppedUnopenedSend(NOTHING_TO_INTERRUPT)
    await rig.settleAccepted(stoppedSend, 'stopped')
    await turnOpenedBy(stoppedSend, 'running')

    expect(await evicted()).toEqual(['user-stop'])
    expect(await rig.queuePause()).toMatchObject({ reason: 'stopped' })
    expect(await rig.handoff(card)).toBeUndefined()
    await turnOpenedBy(stoppedSend, 'interrupted')

    expect(turn()).toMatchObject({ state: 'interrupted' })
    expect(turn()).not.toHaveProperty('outcome')
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
      { answer: 'took', eventId: latestEventId(), text: 'Cancellation requested.' }
    ])
    expect(turn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it('answers end-owed when the Stop ends the provider process next, whatever it answered', async () => {
    await runningTurn({ stopEndsSession: true })
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: {} })

    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    expect(answers()).toEqual([
      { answer: 'end-owed', eventId: latestEventId(), text: 'Cancellation requested.' }
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
      { answer: 'declined', eventId: latestEventId(), text: expect.stringContaining("didn't stop") }
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
      { answer: 'took', eventId: latestEventId(), text: 'Cancellation requested.' }
    ])
    await restartAndSettle()
    expect(turn()).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })
})

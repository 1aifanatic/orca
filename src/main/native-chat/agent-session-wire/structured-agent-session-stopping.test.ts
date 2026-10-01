// The host's "Stopping…": published on the session's status from the moment a person's Stop takes
// effect until the work it stopped ends, or the Stop answers that it stopped nothing. Derived from
// the journal on every publish, so it clears by itself. Driven through the real host and its status
// feed, with turn rows named as Codex writes them.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelOutcome } from './structured-agent-session-adapter'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import { HOST_TEST_SESSION, hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

function fence(): number {
  return rig.store.getRecord(HOST_TEST_SESSION)?.lease.runtimeFence ?? 1
}

function turnIdentity(turnId: string): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 999 }
}

/** Turn `turnId`, opened by send `clientMessageId`, running or ended as the provider cut it. */
async function turn(turnId: string, clientMessageId: string, state: 'running' | 'interrupted') {
  await journal().appendItem(
    turnIdentity(turnId),
    {
      kind: 'turn',
      turnId,
      startedAt: Date.now(),
      userItemId: agentJournalSubmissionKey(clientMessageId),
      ...(state === 'running' ? { state } : { state, completedAt: Date.now() + 5 })
    },
    { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** The session's summaries as a session list receives them. */
function watchStatus(): () => AgentSessionStatusSummary | undefined {
  const events: AgentSessionStatusEvent[] = []
  rig.host.subscribeStatus({ id: 'list', emit: (event) => events.push(event) })
  return () => {
    for (const event of events.toReversed()) {
      if (event.type === 'status' && event.session.sessionId === HOST_TEST_SESSION) {
        return event.session
      }
      if (event.type === 'snapshot') {
        return event.sessions.find((session) => session.sessionId === HOST_TEST_SESSION)
      }
    }
    return undefined
  }
}

/** The Stop as the phone sends it, naming the turn its journal shows running. */
function namedStop(turnId: string) {
  return rig.host.cancel(QUEUED_RIG_CALLER, {
    envelope: rig.envelope({ turnId }, 'agentSession.cancel', hostTestOperationId()),
    turnId
  })
}

/** What each Stop answered, oldest first. */
function stopAnswers(): (string | undefined)[] {
  return journal()
    .snapshot()
    .items.filter((item) => isStructuredAgentSessionStopNote(item.itemId))
    .map((item) => (item.body.kind === 'status' ? (item.body.failure?.kind ?? 'took') : undefined))
}

/** A send whose turn `turn-1` is running, and the session's status. */
async function runningTurn(options: { stopEndsSession?: true } = {}) {
  rig = await createQueuedMessageTestRig(options)
  const sent = await rig.workingSend()
  await rig.settleAccepted(sent, 'sent')
  await turn('turn-1', sent, 'running')
  const status = watchStatus()
  await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
  expect(status()).not.toHaveProperty('stopping')
  return { sent, status }
}

describe("a person's Stop reads Stopping until the work it stopped ends", () => {
  it('reads Stopping once the Stop takes effect, and clears when the turn ends', async () => {
    const { sent, status } = await runningTurn()

    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))

    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    expect(status()).not.toHaveProperty('stopping')
  })

  it('reads Stopping before the agent answers the interrupt', async () => {
    const { status } = await runningTurn()
    let answer: (outcome: AgentSessionCancelOutcome) => void = () => undefined
    rig.cancelTurn.mockImplementationOnce(
      () => new Promise<AgentSessionCancelOutcome>((resolve) => (answer = resolve))
    )

    const stopped = rig.stop()
    await eventually(() => expect(status()).toMatchObject({ stopping: true }))

    answer({ cancelled: true })
    expect(await stopped).toMatchObject({ ok: true })
    expect(status()).toMatchObject({ stopping: true })
  })

  const refused = async (): Promise<AgentSessionCancelOutcome> => ({ cancelled: false })
  const unconfirmed = async (): Promise<AgentSessionCancelOutcome> => {
    throw new Error('the interrupt request timed out')
  }
  it.each([
    ['refused', 'names no turn', refused],
    ['left unconfirmed', 'names no turn', unconfirmed],
    ['left unconfirmed', 'names the turn', unconfirmed]
  ])(
    'reads Working again once the agent %s a Stop that %s, while its turn runs on',
    async (_, naming, cancel) => {
      const { status } = await runningTurn()
      rig.cancelTurn.mockImplementationOnce(cancel)

      const stopped = naming === 'names the turn' ? namedStop('turn-1') : rig.stop()
      expect(await stopped).toMatchObject({ ok: true })

      await eventually(() => expect(journal().stopMarks.latest()).not.toBeNull())
      await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
      expect(status()).not.toHaveProperty('stopping')
    }
  )

  it('reads Stopping again when a later press of the same Stop takes', async () => {
    const { status } = await runningTurn()
    rig.cancelTurn.mockImplementationOnce(async () => ({ cancelled: false }))
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(journal().stopMarks.latest()).not.toBeNull())
    const refusedStop = journal().stopMarks.latest()

    expect(await rig.stop()).toMatchObject({ ok: true })

    // That press wrote no second event: its answer alone tells.
    expect(journal().stopMarks.latest()).toEqual(refusedStop)
    await eventually(() => expect(status()).toMatchObject({ stopping: true }))
  })

  it('keeps Stopping when a repeat press is refused after an earlier press took', async () => {
    const { status } = await runningTurn()
    let answer: (outcome: AgentSessionCancelOutcome) => void = () => undefined
    rig.cancelTurn.mockImplementationOnce(
      () => new Promise<AgentSessionCancelOutcome>((resolve) => (answer = resolve))
    )
    const first = rig.stop()
    await eventually(() => expect(status()).toMatchObject({ stopping: true }))
    // Queued behind the first on the session's lane, it reaches an agent already stopping.
    rig.cancelTurn.mockImplementationOnce(refused)
    const repeat = rig.stop()

    answer({ cancelled: true })
    expect(await first).toMatchObject({ ok: true })
    expect(await repeat).toMatchObject({ ok: true })

    await eventually(() => expect(stopAnswers()).toEqual(['took', 'stopRefused']))
    expect(status()).toMatchObject({ status: 'working', stopping: true })
  })

  it('never marks a turn that opened after the stopped one ended', async () => {
    const { sent, status } = await runningTurn()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))

    const next = await rig.workingSend()
    await rig.settleAccepted(next, 'next')
    await turn('turn-2', next, 'running')

    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')
  })
})

describe('a Stop pressed before its send opened a turn', () => {
  it('reads Stopping through the turn that send opens, until that turn ends', async () => {
    rig = await createQueuedMessageTestRig()
    const sent = await rig.workingSend()
    const status = watchStatus()

    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event).not.toHaveProperty('turnId')
    await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))

    await rig.settleAccepted(sent, 'sent')
    await turn('turn-1', sent, 'running')
    await eventually(() => expect(journal().activeTurnId()).toBe('turn-1'))
    expect(status()).toMatchObject({ status: 'working', stopping: true })

    await turn('turn-1', sent, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    expect(status()).not.toHaveProperty('stopping')
  })

  it("reads the stopped send's turn and a later one from the turn record, never walking the journal for it", async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    const status = watchStatus()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(stopped, 'stopped')
    const walk = vi.spyOn(journal().stopMarks, 'personStopDecides')

    await turn('turn-1', stopped, 'running')
    await eventually(() => expect(status()).toMatchObject({ status: 'working', stopping: true }))
    await turn('turn-1', stopped, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))
    const later = await rig.workingSend()
    await rig.settleAccepted(later, 'later')
    await turn('turn-2', later, 'running')
    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')

    // Only the no-turn case may walk: a running turn's opener comes from its own record.
    expect(walk.mock.calls.filter(([turnId]) => turnId !== null)).toEqual([])
  })

  it('reads a send made after the Stop as Working', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    const status = watchStatus()
    expect(await rig.stop()).toMatchObject({ ok: true })
    await rig.settleAccepted(stopped, 'stopped')
    await turn('turn-1', stopped, 'interrupted')
    await eventually(() => expect(status()?.status).toBe('idle'))

    const later = await rig.workingSend()
    await rig.settleAccepted(later, 'later')
    await turn('turn-2', later, 'running')

    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')
  })
})

describe('a Stop whose provider ends its session', () => {
  it("reads Working once the child's end fails, and Stopping again when the next Stop retries it", async () => {
    const { status } = await runningTurn({ stopEndsSession: true })
    rig.closeSession.mockRejectedValueOnce(new Error('the kill timed out'))

    expect(await rig.stop()).toMatchObject({ ok: true })

    await eventually(() => expect(stopAnswers()).toEqual(['cancelUnconfirmed']))
    await eventually(() => expect(status()).toMatchObject({ status: 'working' }))
    expect(status()).not.toHaveProperty('stopping')

    // The retry's child end is held, so the status can be read while it runs.
    const retried = Promise.withResolvers<boolean>()
    rig.closeSession.mockImplementationOnce(() => retried.promise)
    expect(await rig.stop()).toMatchObject({ ok: true })
    await eventually(() => expect(rig.closeSession).toHaveBeenCalledTimes(2))
    expect(stopAnswers()).toEqual(['cancelUnconfirmed', 'took'])
    expect(status()).toMatchObject({ status: 'working', stopping: true })
    retried.resolve(true)
  })
})

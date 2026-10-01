// The host's "Stopping…": published on the session's status from the moment a person's Stop takes
// effect until the work it stopped ends, or the Stop answers that it stopped nothing. Derived from
// the journal on every publish, so it clears by itself. Driven through the real host and its status
// feed, with turn rows named as Codex writes them.

import { afterEach, describe, expect, it } from 'vitest'
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
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
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

/** A send whose turn `turn-1` is running, and the session's status. */
async function runningTurn() {
  rig = await createQueuedMessageTestRig()
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

  it.each([
    ['refused', async () => ({ cancelled: false })],
    [
      'left unconfirmed',
      async (): Promise<AgentSessionCancelOutcome> => {
        throw new Error('the interrupt request timed out')
      }
    ]
  ])(
    'reads Working again once the agent %s the Stop, while its turn runs on',
    async (_, cancel) => {
      const { status } = await runningTurn()
      rig.cancelTurn.mockImplementationOnce(cancel)

      expect(await rig.stop()).toMatchObject({ ok: true })

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

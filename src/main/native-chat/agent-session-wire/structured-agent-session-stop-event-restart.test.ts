// A Stop that took effect still decides its turn after Orca restarts before the turn's end was
// written: the relaunch's settle reads the Stop's event, so the turn reads "Interrupted after N"
// with the muted mark, not "Failed". A turn nobody stopped, and one whose Stop the provider refused
// while the turn ran on, still read as the news they are.

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { agentVerdictDisplayMark } from '../../../shared/agent-main-agent-verdict'
import { agentTurnVerdict } from '../../../shared/agent-turn-outcome'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { formatNativeChatTurnStatusLabel } from '../../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../../shared/structured-agent-session-turn-timing'
import { settleStaleStructuredAgentSessionState } from './structured-agent-session-dead-generation-settlement'
import { HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import {
  createQueuedMessageTestRig,
  eventually,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

const TURN = 'turn-1'
/** The provider rows a turn lives on: the Claude lane's, and Codex's. */
const CLAUDE_TURN: AgentJournalItemIdentity = {
  provider: 'claude',
  sessionId: 'provider-session-1',
  uuid: 'uuid-turn'
}
const CODEX_TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: TURN,
  ordinal: 999
}

let rig: QueuedMessageTestRig

afterEach(() => rig.dispose())

function journal() {
  const open = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  if (!open) {
    throw new Error('expected the conversation open')
  }
  return open
}

/** A send the provider is working on, with its turn running since half a minute ago. */
async function runningTurn(
  identity: AgentJournalItemIdentity,
  options: { stopEndsSession?: true } = {}
): Promise<void> {
  rig = await createQueuedMessageTestRig(options)
  await rig.workingSend()
  await journal().appendItem(
    identity,
    { kind: 'turn', turnId: TURN, state: 'running', startedAt: Date.now() - 30_000 },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

/** Orca dies with the turn's end unwritten; the relaunch reopens the chat from disk and proves
 *  the old child gone (its last renewal came before the Stop), then settles what it left. */
async function restartAndSettle(
  proof: 'pid-absent' | 'exit-observed' | 'unproven' = 'pid-absent'
): Promise<void> {
  rig.crashRestartHostProcess()
  await rig.host.journalSnapshot(HOST_TEST_SESSION)
  const now = Date.now()
  const deathEvidence: AgentSessionDeathEvidence | null =
    proof === 'unproven'
      ? null
      : {
          kind: proof,
          detail: 'the relaunch proved the old child gone',
          observedAt: now + 60_000,
          ownerFence: 1,
          lastProvenAliveAt: now - 20_000
        }
  await settleStaleStructuredAgentSessionState({
    journal: journal(),
    sessionId: HOST_TEST_SESSION,
    fence: 2,
    acquisitionGeneration: 'generation-2',
    deathEvidence
  })
}

/** What the chat's turn bar and the session's mark read. */
function settled() {
  const { items } = journal().snapshot()
  const turn = items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  const [timing] = [...selectStructuredAgentSettledTurns(items).values()]
  const verdict = turn
    ? agentTurnVerdict({ state: turn.state, outcome: turn.outcome ?? null })
    : null
  return {
    turn,
    label: timing ? formatNativeChatTurnStatusLabel({ elapsedSeconds: 0, ...timing }) : null,
    mark: verdict
      ? agentVerdictDisplayMark({ state: 'done', mainAgent: { state: 'done', outcome: verdict } })
      : null
  }
}

describe('a restart between a Stop and its turn end', () => {
  it.each([
    ['a Claude Stop before its result arrives', CLAUDE_TURN],
    ['a Codex Stop before turn/completed', CODEX_TURN]
  ])('reads Interrupted after N, marked interrupted: %s', async (_label, identity) => {
    await runningTurn(identity)
    // The provider took the interrupt; its end never arrived.
    expect(await rig.stop()).toMatchObject({ ok: true })

    await restartAndSettle()

    const { turn, label, mark } = settled()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(label).toMatch(/^Interrupted after /)
    expect(mark).toBe('interrupted')
  })

  it('reads Interrupted after N, marked interrupted: a close of the chat that died midway', async () => {
    await runningTurn(CODEX_TURN)
    // The host dies inside the close: the provider's close never answers, and nothing settles.
    rig.closeSession.mockImplementationOnce(() => Promise.reject(new Error('host died')))
    await expect(rig.host.close(HOST_TEST_SESSION, 'user-close')).rejects.toThrow()
    expect(journal().stopMarks.latest()?.event).toMatchObject({
      reason: 'user-close',
      turnId: TURN
    })

    await restartAndSettle()

    const { turn, label, mark } = settled()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    expect(label).toMatch(/^Interrupted after /)
    expect(mark).toBe('interrupted')
  })

  it('reads Failed after N, marked failed, when nobody stopped it', async () => {
    await runningTurn(CODEX_TURN)

    await restartAndSettle()

    const { turn, label, mark } = settled()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(label).toMatch(/^Failed after /)
    expect(mark).toBe('failed')
  })

  it("reads Couldn't confirm when the relaunch cannot prove the child gone, Stop or not", async () => {
    // The Stop says whose end it was, never that the turn ended.
    await runningTurn(CODEX_TURN)
    expect(await rig.stop()).toMatchObject({ ok: true })

    await restartAndSettle('unproven')

    const { turn, mark } = settled()
    expect(turn).toMatchObject({ state: 'unverifiable' })
    expect(mark).toBe('unconfirmed')
  })

  it('reads Failed after N when the provider refused the Stop and the turn ran on until the crash', async () => {
    await runningTurn(CODEX_TURN)
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: {} })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: false } })
    await eventually(async () => expect(journal().stopMarks.latest()?.refused).toBe(true))

    await restartAndSettle()

    const { turn, label, mark } = settled()
    expect(turn).not.toHaveProperty('outcome')
    expect(label).toMatch(/^Failed after /)
    expect(mark).toBe('failed')
  })

  // Claude's Stop ends its child whatever the interrupt answered, so only Codex writes a refusal.
  it('reads Interrupted after N when the provider refused a Stop that ends its child', async () => {
    await runningTurn(CLAUDE_TURN, { stopEndsSession: true })
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: {} })
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    // The Stop's next step on the session's lane ends the child.
    await rig.host['tasks'].serialize(HOST_TEST_SESSION, async () => {})
    expect(rig.closeSession).toHaveBeenCalled()
    expect(journal().stopMarks.latest()).toMatchObject({ refused: false })

    await restartAndSettle()

    expect(settled().turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })

  it('reads a turn a send made after a Stop pressed before any turn showed as no Stop of its', async () => {
    rig = await createQueuedMessageTestRig()
    const stopped = await rig.workingSend()
    // Pressed before the turn showed: the Stop names no turn.
    expect(await rig.stop()).toMatchObject({ ok: true })
    expect(journal().stopMarks.latest()?.event.turnId).toBeUndefined()
    await rig.settleAccepted(stopped, 'stopped')
    const next = rig.send('sent after the Stop')
    await next.result
    await rig.settleAccepted(next.id, 'next')
    await journal().appendItem(
      CODEX_TURN,
      { kind: 'turn', turnId: TURN, state: 'running', startedAt: Date.now() - 30_000 },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    // Its exit is proven after the Stop, so only whose turn it is decides.
    await restartAndSettle('exit-observed')

    expect(settled().turn).toMatchObject({ state: 'interrupted' })
    expect(settled().turn).not.toHaveProperty('outcome')
  })

  it('a Stop pressed again after a refusal is a new Stop, which its turn end reads', async () => {
    await runningTurn(CODEX_TURN)
    rig.cancelTurn.mockResolvedValueOnce({ cancelled: false, refusal: {} })
    await rig.stop()
    expect(await rig.stop()).toMatchObject({ ok: true, value: { cancelled: true } })

    await restartAndSettle()

    expect(settled().turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
  })
})

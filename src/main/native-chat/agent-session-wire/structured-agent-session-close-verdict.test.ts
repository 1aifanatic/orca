// A turn the host cuts short by closing its provider is the user's cancellation only when the user
// closed this chat. A quit, an idle eviction or a teardown aimed elsewhere leaves it news: the user
// needs to learn it did not finish. The decision is written where the host settles the turn.

import { beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionStatusEvent } from '../../../shared/agent-session-wire'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { describeNativeChatTurnStatus } from '../../../shared/native-chat-turn-status'
import { selectStructuredAgentSettledTurns } from '../../../shared/structured-agent-session-turn-timing'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { attach, hostTestState } from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost

beforeEach(() => {
  host = hostTestState().host
})

/** A running turn, anchored to its user row, with a status list watching the session. */
async function runningTurn(): Promise<AgentSessionStatusEvent[]> {
  await attach()
  const events = hostTestState().acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 0 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] }
  )
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 1 },
    { kind: 'turn', turnId: 'cut-turn', state: 'running', startedAt: 1_000, requestedAt: 1_000 }
  )
  await host.flushStreamedEvents(SESSION)
  const statuses: AgentSessionStatusEvent[] = []
  host.subscribeStatus({ id: 'list', emit: (event) => statuses.push(event) })
  return statuses
}

/** What the settle wrote, read back from the journal the next reader opens. */
async function settledTurn() {
  await host.restoreReadableSessions([SESSION])
  const items = host.journalSnapshot(SESSION).items
  const turn = items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
  const [settled] = [...selectStructuredAgentSettledTurns(items).values()]
  return { turn, settled }
}

function lastSummary(statuses: AgentSessionStatusEvent[]) {
  const last = statuses.at(-1)
  return last?.type === 'status' ? last.session : null
}

describe('a turn cut short by closing its provider', () => {
  it("records the user's close of this chat as their cancellation", async () => {
    const statuses = await runningTurn()

    await host.close(SESSION, { requestedByUser: true })

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'cancellation' })
    const { turn, settled } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted', outcome: 'cancellation' })
    // A stop the user asked for folds like any other finished turn.
    expect(
      settled && describeNativeChatTurnStatus({ thinking: false, elapsedSeconds: 0, ...settled })
    ).toMatchObject({ key: 'workedFor' })
  })

  it('leaves a close the user did not aim at this chat as news', async () => {
    const statuses = await runningTurn()

    // What an idle eviction, a worktree teardown or an orchestration stop issues.
    await host.close(SESSION)

    expect(lastSummary(statuses)).toMatchObject({ status: 'idle', turnOutcome: 'interruption' })
    const { turn, settled } = await settledTurn()
    expect(turn).toMatchObject({ state: 'interrupted' })
    expect(turn).not.toHaveProperty('outcome')
    expect(
      settled && describeNativeChatTurnStatus({ thinking: false, elapsedSeconds: 0, ...settled })
    ).toMatchObject({ key: 'interruptedAfter' })
  })

  it('leaves a quit as news', async () => {
    const statuses = await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'quit' })

    expect(statuses.findLast((event) => event.type === 'status')).toMatchObject({
      session: { status: 'idle', turnOutcome: 'interruption' }
    })
  })
})

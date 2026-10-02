// Whether a Stop still counts, read from its notes' answers: until it has one, and then while any
// says it took. The turn-end rule reads it, so a turn a Stop that took nothing named ends as the
// news it is.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalStopNoteAnswer,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-answers',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const SCOPE = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
const TURN: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 0
}

let root: string
let journal: AgentSessionJournal
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-answers-'))
  journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A person's Stop of `turn-1`, as its own step writes it; its event's time. */
async function stopped(): Promise<number> {
  await journal.appendStopEvent({ reason: 'user-stop', turnId: 'turn-1' }, 1)
  return journal.stopMarks.latest()!.event.at
}

/** A Stop's note at `key`, as `performCancel` writes it. */
async function answered(key: string, stop: AgentJournalStopNoteAnswer | undefined): Promise<void> {
  await journal.appendItem(
    { provider: 'orca', clientMessageId: `stop:${key}` },
    { kind: 'status', text: 'Cancellation requested.', ...(stop ? { stop } : {}) },
    SCOPE
  )
}

function stillCounts(): boolean {
  return journal.stopMarks.stillCounts(journal.stopMarks.latest()!.event)
}

describe('journalStopStillCounts', () => {
  it('counts a Stop with no answer yet', async () => {
    await stopped()

    expect(stillCounts()).toBe(true)
  })

  it.each(['declined', 'interrupt-unconfirmed', 'no-effect'] as const)(
    'stops counting a Stop whose only answer is %s',
    async (answer) => {
      const eventAt = await stopped()
      await answered('turn-1', { answer, eventAt })

      expect(stillCounts()).toBe(false)
    }
  )

  it('keeps counting while any answer says it took, a later one that it did not included', async () => {
    const eventAt = await stopped()
    await answered('turn-1', { answer: 'took', eventAt })
    await answered('op-2', { answer: 'no-effect', eventAt })

    expect(stillCounts()).toBe(true)
  })

  it('counts an owed end as taking effect', async () => {
    const eventAt = await stopped()
    await answered('turn-1', { answer: 'end-owed', eventAt })

    expect(stillCounts()).toBe(true)
  })

  it("reads only answers to this Stop: an earlier Stop's, one naming no event, and an older host's note are none", async () => {
    const earlier = await stopped()
    await answered('turn-1', { answer: 'no-effect', eventAt: earlier })
    await new Promise((resolve) => setTimeout(resolve, 2))
    const latest = await stopped()
    expect(latest).not.toBe(earlier)
    await answered('op-2', { answer: 'declined' })
    await answered('op-3', undefined)

    expect(stillCounts()).toBe(true)
  })
})

describe('the turn-end rule', () => {
  /** `turn-1` running, and a person's Stop of it; the event's time. */
  async function stoppedWhileRunning(): Promise<number> {
    await journal.appendItem(
      TURN,
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: Date.now() - 1_000 },
      SCOPE
    )
    return stopped()
  }

  function endTurn(): Promise<unknown> {
    return journal.appendItem(
      TURN,
      { kind: 'turn', turnId: 'turn-1', state: 'interrupted', completedAt: Date.now() + 1_000 },
      SCOPE
    )
  }

  function outcome(): string | undefined {
    return journal
      .snapshot()
      .items.map((item) => readAgentJournalTurn(item.body))
      .find((turn) => turn?.turnId === 'turn-1')?.outcome
  }

  it("makes the end of a turn a Stop that took named the person's cancellation", async () => {
    await answered('turn-1', { answer: 'took', eventAt: await stoppedWhileRunning() })

    await endTurn()

    expect(outcome()).toBe('cancellation')
  })

  it('leaves the end of a turn a declined Stop named as news, so a crash reads as one', async () => {
    await answered('turn-1', { answer: 'declined', eventAt: await stoppedWhileRunning() })

    await endTurn()

    expect(outcome()).toBeUndefined()
    expect(journal.stopMarks.personStopDecides('turn-1')).toBe(false)
  })
})

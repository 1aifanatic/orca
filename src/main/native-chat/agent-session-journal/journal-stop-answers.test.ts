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
let minted = 0
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-answers-'))
  minted = 0
  // One millisecond for every row: an answer must find its Stop by id, never by time.
  journal = await journals.open({ identity: IDENTITY, stateDirectory: root, now: () => 1_000 })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A Stop of `turn-1`, a person's unless `reason` says otherwise, as its writer writes it; its
 *  event's id. */
async function stopped(reason: 'user-stop' | 'user-close' = 'user-stop'): Promise<string> {
  const id = `stop-${++minted}`
  await journal.appendStopEvent({ id, reason, turnId: 'turn-1' }, 1)
  return id
}

/** A Stop's note at `key`, as `performCancel` writes it. */
async function answered(
  key: string,
  stop: AgentJournalStopNoteAnswer | undefined,
  identity: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: `stop:${key}` }
): Promise<void> {
  await journal.appendItem(
    identity,
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
      const eventId = await stopped()
      await answered('turn-1', { answer, eventId })

      expect(stillCounts()).toBe(false)
    }
  )

  it('keeps counting while any answer says it took, a later one that it did not included', async () => {
    const eventId = await stopped()
    await answered('turn-1', { answer: 'took', eventId })
    await answered('op-2', { answer: 'no-effect', eventId })

    expect(stillCounts()).toBe(true)
  })

  it('counts an owed end as taking effect', async () => {
    const eventId = await stopped()
    await answered('turn-1', { answer: 'end-owed', eventId })

    expect(stillCounts()).toBe(true)
  })

  it("reads only answers to this Stop: an earlier Stop's in the same millisecond, one naming no event, and an older host's note are none", async () => {
    const earlier = await stopped()
    await answered('turn-1', { answer: 'no-effect', eventId: earlier })
    await stopped()
    expect(journal.stopMarks.latest()?.event.at).toBe(1_000)
    await answered('op-2', { answer: 'declined' })
    await answered('op-3', undefined)

    expect(stillCounts()).toBe(true)
  })

  it("keeps counting a person's close written in the same millisecond as their declined Stop", async () => {
    await answered('turn-1', { answer: 'declined', eventId: await stopped() })
    await stopped('user-close')

    expect(stillCounts()).toBe(true)
    expect(journal.stopMarks.personStopDecides('turn-1')).toBe(true)
  })

  it("reads an answer only from a Stop's note", async () => {
    const eventId = await stopped()
    await answered('row', { answer: 'declined', eventId }, TURN)

    expect(stillCounts()).toBe(true)
  })

  it('counts an event an early build wrote with no id: no answer names it', async () => {
    await answered('op-1', { answer: 'declined' })

    expect(journal.stopMarks.stillCounts({})).toBe(true)
  })

  it('links an answer a rewind keeps to the Stop it restates, by the id the restatement keeps', async () => {
    const eventId = await stopped()
    const note = { provider: 'orca' as const, clientMessageId: 'stop:turn-1' }

    await journal.replaceEpochItems('legacy_import', 1, [
      {
        identity: note,
        body: { kind: 'status', text: 'Codex didn’t stop.', stop: { answer: 'declined', eventId } }
      }
    ])

    expect(journal.stopMarks.latest()?.event).toMatchObject({ id: eventId, reason: 'user-stop' })
    expect(stillCounts()).toBe(false)
  })
})

describe('the turn-end rule', () => {
  /** `turn-1` running, and a person's Stop of it; the event's id. */
  async function stoppedWhileRunning(): Promise<string> {
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
    await answered('turn-1', { answer: 'took', eventId: await stoppedWhileRunning() })

    await endTurn()

    expect(outcome()).toBe('cancellation')
  })

  it('leaves the end of a turn a declined Stop named as news, so a crash reads as one', async () => {
    await answered('turn-1', { answer: 'declined', eventId: await stoppedWhileRunning() })

    // Still the person's Stop of the turn, which a host stop defers to; not their end.
    expect(journal.stopMarks.personStopCovers('turn-1')).toBe(true)
    expect(journal.stopMarks.personStopDecides('turn-1')).toBe(false)
    await endTurn()

    expect(outcome()).toBeUndefined()
  })
})

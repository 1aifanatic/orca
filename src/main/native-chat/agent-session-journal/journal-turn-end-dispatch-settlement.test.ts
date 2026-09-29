// The provider's end of the turn it was running ends what a send handed to it was owed, on either
// write path, and never for a revision of an earlier turn, a host settlement or another fence.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'
import { owesStructuredAgentSessionWork } from '../../../shared/structured-agent-session-owed-work'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

const FENCE = 3
const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000

function turnRow(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'claude', sessionId: 'claude-1', uuid: `${turnId}-${ordinal}` }
}

function turn(
  turnId: string,
  state: AgentJournalTurnItem['state'],
  outcome?: AgentJournalTurnItem['outcome']
): AgentJournalTurnItem {
  return { kind: 'turn', turnId, state, ...(outcome ? { outcome } : {}) }
}

async function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      hostId: 'host-1',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'claude-1', leafUuid: null }
    },
    journalDir: root,
    now: () => ++clock,
    mintEpoch: () => 'epoch-1'
  })
}

/** A send accepted and handed to the provider, awaiting its answer. */
async function handOver(journal: AgentSessionJournal, clientMessageId: string, fence = FENCE) {
  await journal.appendSubmission({
    clientMessageId,
    payloadFingerprint: `fingerprint-${clientMessageId}`,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    fence,
    handoverRecorded: true
  })
  await journal.resolveDispatch({ clientMessageId, state: 'pending', fence })
}

function dispatchOf(journal: AgentSessionJournal, clientMessageId: string) {
  return journal.submissions().find((entry) => entry.clientMessageId === clientMessageId)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-turn-end-settlement-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a turn the provider ends', () => {
  it.each([
    ['completed', 'success'],
    ['completed', 'failure'],
    ['interrupted', 'cancellation'],
    ['unverifiable', undefined]
  ] as const)(
    'settles the sends it left unanswered in doubt when it ends %s (%s)',
    async (state, outcome) => {
      const journal = await open()
      await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'running'), { fence: FENCE })
      await handOver(journal, 'steer')

      await journal.appendItem(turnRow('turn-1', 1), turn('turn-1', state, outcome), {
        fence: FENCE
      })

      expect(dispatchOf(journal, 'steer')).toMatchObject({
        dispatchState: 'unknown',
        reason: 'turn_settled_before_acknowledgement',
        recovered: true
      })
      const snapshot = journal.snapshot()
      expect(owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, FENCE)).toBe(
        false
      )
    }
  )

  it('settles through a lifecycle batch as through a single row', async () => {
    const journal = await open()
    await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'running'), { fence: FENCE })
    await handOver(journal, 'steer')

    await journal.appendLifecycleBatch({
      settlementId: 'turn-1-end',
      fence: FENCE,
      mutations: [
        { kind: 'item', identity: turnRow('turn-1', 0), body: turn('turn-1', 'completed') }
      ]
    })

    expect(dispatchOf(journal, 'steer')).toMatchObject({
      dispatchState: 'unknown',
      recovered: true
    })
  })

  it('lets a late echo replace the doubt', async () => {
    const journal = await open()
    await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'running'), { fence: FENCE })
    await handOver(journal, 'steer')
    await journal.appendItem(turnRow('turn-1', 1), turn('turn-1', 'completed'), { fence: FENCE })

    await journal.resolveDispatch({
      clientMessageId: 'steer',
      state: 'accepted',
      providerIdentity: turnRow('echo', 0),
      fence: FENCE
    })

    expect(dispatchOf(journal, 'steer')).toMatchObject({ dispatchState: 'accepted' })
    expect(dispatchOf(journal, 'steer')?.recovered).toBeUndefined()
  })

  it('leaves a send it never held: queued, another fence, or handed over after the end', async () => {
    const journal = await open()
    await handOver(journal, 'older-child', FENCE - 1)
    await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'running'), { fence: FENCE })
    await journal.appendSubmission({
      clientMessageId: 'queued',
      payloadFingerprint: 'fingerprint-queued',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued' }] },
      fence: FENCE,
      handoverRecorded: true
    })

    const ended = journal.appendItem(turnRow('turn-1', 1), turn('turn-1', 'completed'), {
      fence: FENCE
    })
    const after = handOver(journal, 'after-the-end')
    await Promise.all([ended, after])

    expect(dispatchOf(journal, 'queued')?.dispatchState).toBe('pending')
    expect(dispatchOf(journal, 'older-child')?.dispatchState).toBe('pending')
    expect(dispatchOf(journal, 'after-the-end')?.dispatchState).toBe('pending')
  })

  it('ends nothing when it revises an earlier turn while a later one runs', async () => {
    const journal = await open()
    await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'completed'), { fence: FENCE })
    await journal.appendItem(turnRow('turn-2', 0), turn('turn-2', 'running'), { fence: FENCE })
    await handOver(journal, 'steer')

    await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'interrupted'), {
      fence: FENCE
    })

    expect(dispatchOf(journal, 'steer')?.dispatchState).toBe('pending')
  })

  it("leaves a host settlement's sends to the reason it gives them", async () => {
    const journal = await open()
    await journal.appendItem(turnRow('turn-1', 0), turn('turn-1', 'running'), { fence: FENCE })
    await handOver(journal, 'steer')

    await journal.appendLifecycleBatch({
      settlementId: 'dead-generation',
      fence: FENCE,
      recovered: true,
      mutations: [
        { kind: 'item', identity: turnRow('turn-1', 0), body: turn('turn-1', 'interrupted') }
      ]
    })

    expect(dispatchOf(journal, 'steer')?.dispatchState).toBe('pending')
  })
})

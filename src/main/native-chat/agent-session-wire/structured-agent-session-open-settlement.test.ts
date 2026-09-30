// The stored "owes work" flag and the open's settlement plan are two readings of one set of rules:
// the flag selects a chat exactly when its open would write something, the open writes exactly the
// plan, and once the plan commits the flag reads false again, so nothing is selected twice.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { owesOnOpen } from '../agent-session-journal/journal-open-settlement-plan'
import { readJournalSessionState } from '../agent-session-journal/journal-session-state'
import {
  CORPUS_DEATH_EVIDENCE,
  CORPUS_FENCE,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS
} from '../agent-session-journal/journal-session-state-test-corpus'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  appendOpenSettlement,
  openSettlementPlanIsEmpty,
  planOpenSettlement,
  type OpenSettlementRecordFacts
} from './structured-agent-session-open-settlement'

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000
let chats = 0

function open(sessionId: string): Promise<AgentSessionJournal> {
  const identity: AgentSessionJournalIdentity = {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: `thread-${sessionId}` }
  }
  return journals.open({
    identity,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}`
  })
}

function storedFacts(sessionId: string) {
  const row = readJournalSessionState(openTestJournalHostDatabase(root).db, sessionId)
  if (!row) {
    throw new Error(`no stored state for ${sessionId}`)
  }
  return row
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-open-settlement-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const COMBINATIONS = JOURNAL_SESSION_STATE_CASES.flatMap((name) =>
  Object.keys(CORPUS_DEATH_EVIDENCE).map((evidence) => [name, evidence] as const)
)

describe('the stored flag and the plan agree (T4)', () => {
  it.each(COMBINATIONS)('%s, death evidence %s', async (name, evidenceName) => {
    const sessionId = `chat-${(chats += 1)}`
    const journal = await open(sessionId)
    await JOURNAL_SESSION_STATE_CORPUS[name](journal)
    const deathEvidence = CORPUS_DEATH_EVIDENCE[evidenceName] ?? null
    const record: OpenSettlementRecordFacts = { sessionId, fence: CORPUS_FENCE, deathEvidence }

    const plan = planOpenSettlement(journal, record, { settlesRosters: true })
    const selected = owesOnOpen(storedFacts(sessionId), deathEvidence)
    expect(selected).toBe(!openSettlementPlanIsEmpty(plan))

    // The open appends exactly the plan: a row per roster, per recovered send and per rejected
    // leftover, and one lifecycle batch for what the gone generation left.
    const before = liveTestJournalRows(openTestJournalHostDatabase(root).db, sessionId).length
    await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
      throw error
    })
    const appended =
      liveTestJournalRows(openTestJournalHostDatabase(root).db, sessionId).length - before
    expect(appended).toBe(
      plan.rosters.length +
        plan.recoveredDispatches.length +
        plan.leftoverQueued.length +
        ((plan.goneGeneration?.mutations.length ?? 0) > 0 ? 1 : 0)
    )

    // Every entry revised its entity out of the state that selected it (T4b, T15b).
    expect(owesOnOpen(storedFacts(sessionId), deathEvidence)).toBe(false)
    expect(
      openSettlementPlanIsEmpty(planOpenSettlement(journal, record, { settlesRosters: true }))
    ).toBe(true)
  })

  it('owes nothing for a settled chat, whatever the record says', async () => {
    const journal = await open('settled')
    await JOURNAL_SESSION_STATE_CORPUS.settled(journal)
    for (const deathEvidence of Object.values(CORPUS_DEATH_EVIDENCE)) {
      expect(owesOnOpen(storedFacts('settled'), deathEvidence)).toBe(false)
    }
  })

  it("selects an unverifiable turn only by evidence naming its writer, never an older build's", async () => {
    const journal = await open('unverifiable')
    await JOURNAL_SESSION_STATE_CORPUS['unverifiable turn'](journal)
    const facts = storedFacts('unverifiable')
    expect(facts).toMatchObject({ owesWork: false, unverifiableOwnerFences: [CORPUS_FENCE] })
    expect(owesOnOpen(facts, CORPUS_DEATH_EVIDENCE['older build, no owner'])).toBe(false)
    expect(owesOnOpen(facts, CORPUS_DEATH_EVIDENCE['names another owner'])).toBe(false)
    expect(owesOnOpen(facts, CORPUS_DEATH_EVIDENCE['names the writer'])).toBe(true)
  })

  it('makes a chat whose only debt is a queued leftover owe work, and settles it (T15b)', async () => {
    const journal = await open('queued')
    await JOURNAL_SESSION_STATE_CORPUS['queued leftover'](journal)
    expect(storedFacts('queued')).toMatchObject({ owesWork: true, summary: null })
    const plan = planOpenSettlement(journal, null, { settlesRosters: true })
    expect(plan.leftoverQueued).toEqual(['send-queued'])

    await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
      throw error
    })

    expect(journal.submission('send-queued')).toMatchObject({ dispatchState: 'rejected' })
    expect(storedFacts('queued')).toMatchObject({ owesWork: false, summary: { status: 'idle' } })
  })
})

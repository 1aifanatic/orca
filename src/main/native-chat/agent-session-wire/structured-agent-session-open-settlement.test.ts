// A chat's stored status and its settlement plan are two readings of one set of rules: startup
// selects a chat exactly when its settle would write something, the settle writes exactly the plan,
// and once the plan commits the status reads settled, so nothing is selected twice. Death evidence
// changes only which verdict a running turn gets, never whether the chat is selected.

import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalItemBody,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import { isUnsettledJournalSessionStatus } from '../agent-session-journal/journal-session-state'
import {
  CORPUS_DEATH_EVIDENCE,
  CORPUS_FENCE,
  CORPUS_UNSETTLED,
  JOURNAL_SESSION_STATE_CASES,
  JOURNAL_SESSION_STATE_CORPUS
} from '../agent-session-journal/journal-session-state-test-corpus'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  appendOpenSettlement,
  planOpenSettlement,
  type OpenSettlementPlan,
  type OpenSettlementRecordFacts
} from './structured-agent-session-open-settlement'

function openSettlementPlanIsEmpty(plan: OpenSettlementPlan): boolean {
  return (
    plan.recoveredDispatches.length === 0 &&
    plan.leftoverQueued.length === 0 &&
    (plan.goneGeneration?.mutations.length ?? 0) === 0 &&
    plan.rosters.length === 0
  )
}

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
    providerHandle: codexProviderHandle(`thread-${sessionId}`)
  }
  return journals.open({
    identity,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${sessionId}`
  })
}

function storedStatus(sessionId: string) {
  const row = readTestJournalSessionStatus(root, sessionId)
  if (!row) {
    throw new Error(`no stored status for ${sessionId}`)
  }
  return row
}

const selected = (sessionId: string) => isUnsettledJournalSessionStatus(storedStatus(sessionId))

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

describe('the stored status and the plan agree (T4)', () => {
  it.each(COMBINATIONS)('%s, death evidence %s', async (name, evidenceName) => {
    const sessionId = `chat-${(chats += 1)}`
    const writer = await open(sessionId)
    await JOURNAL_SESSION_STATE_CORPUS[name](writer)
    await writer.close()
    // The open after the process that wrote it is gone.
    const journal = await open(sessionId)
    const deathEvidence = CORPUS_DEATH_EVIDENCE[evidenceName] ?? null
    const record: OpenSettlementRecordFacts = { sessionId, fence: CORPUS_FENCE, deathEvidence }

    // Pinned per case, so agreement between the status and the plan cannot hide both being wrong.
    expect(selected(sessionId)).toBe(CORPUS_UNSETTLED[name])
    const plan = planOpenSettlement(journal, record)
    // Evidence naming an `unverifiable` turn's writer lets an open revise it; startup never selects
    // a chat for that (main's acquisition path does it when the chat is next used).
    const revisesVerdictOnly =
      name === 'unverifiable turn' && deathEvidence?.ownerFence === CORPUS_FENCE
    expect(selected(sessionId)).toBe(!openSettlementPlanIsEmpty(plan) && !revisesVerdictOnly)

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
    expect(selected(sessionId)).toBe(false)
    expect(openSettlementPlanIsEmpty(planOpenSettlement(journal, record))).toBe(true)
  })

  it("ends a turn a person's Stop found as theirs, with no row saying the provider stopped", async () => {
    const providerStoppedRows = (plan: ReturnType<typeof planOpenSettlement>) =>
      (plan.goneGeneration?.mutations ?? []).filter(
        (mutation) =>
          mutation.kind === 'item' &&
          mutation.identity.provider === 'orca' &&
          mutation.identity.clientMessageId.includes(':death-')
      )
    const settle = async (evidenceName: string) => {
      const sessionId = `chat-${(chats += 1)}`
      const journal = await open(sessionId)
      await JOURNAL_SESSION_STATE_CORPUS["running turn a person's Stop found"](journal)
      const deathEvidence = CORPUS_DEATH_EVIDENCE[evidenceName] ?? null
      const record: OpenSettlementRecordFacts = { sessionId, fence: CORPUS_FENCE, deathEvidence }
      const plan = planOpenSettlement(journal, record)
      await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
        throw error
      })
      return { sessionId, journal, plan }
    }

    // The process was found dead after the Stop: the Stop decides how the turn ends.
    const after = await settle('names the writer, after a Stop')
    expect(providerStoppedRows(after.plan)).toEqual([])
    expect(after.plan.goneGeneration?.mutations).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'turn', state: 'interrupted' })
      })
    )
    expect(selected(after.sessionId)).toBe(false)
    expect(storedStatus(after.sessionId).summary).toEqual(
      after.journal.sessionStatus.at(undefined).summary
    )

    // Found dead before the Stop event's time: the death explains the end, and says so.
    const before = await settle('names the writer')
    expect(providerStoppedRows(before.plan)).toHaveLength(1)
  })

  it('selects nothing for an item whose key will not parse, which no plan can revise (R1J-4)', async () => {
    const first = await open('unkeyed')
    await JOURNAL_SESSION_STATE_CORPUS.settled(first)
    const tip = first.cursor()
    await first.close()
    const unkeyed = (seq: number, itemId: string, body: AgentJournalItemBody) =>
      insertTestJournalRow(openTestJournalHostDatabase(root).db, 'unkeyed', {
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        kind: 'item',
        itemId,
        revision: 1,
        body,
        epoch: tip.epoch,
        seq,
        fence: CORPUS_FENCE,
        ts: 5_000
      })
    unkeyed(tip.sequence + 1, 'legacy-tool-1', {
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'ls' },
      state: 'running'
    })
    unkeyed(tip.sequence + 2, 'legacy-turn-2', {
      kind: 'turn',
      turnId: 't2',
      state: 'running',
      startedAt: 40
    })
    unkeyed(tip.sequence + 3, 'legacy-turn-3', {
      kind: 'turn',
      turnId: 't3',
      state: 'unverifiable',
      startedAt: 50
    })
    // Written beside the journal, as before the status table: the open writes the status back.
    openTestJournalHostDatabase(root)
      .db.prepare('DELETE FROM journal_session_state WHERE session_id = ?')
      .run('unkeyed')
    const journal = await open('unkeyed')
    // As the chat's open does after its settle.
    journal.sessionStatus.backfill()
    expect(readTestJournalSessionStatus(root, 'unkeyed')).not.toBeNull()
    const deathEvidence = CORPUS_DEATH_EVIDENCE['names the writer'] ?? null
    const plan = planOpenSettlement(journal, {
      sessionId: 'unkeyed',
      fence: CORPUS_FENCE,
      deathEvidence
    })

    expect(openSettlementPlanIsEmpty(plan)).toBe(true)
    expect(storedStatus('unkeyed')).toMatchObject({ lifecycle: 'idle' })
    expect(selected('unkeyed')).toBe(false)
  })

  it('never selects a chat to revise a verdict: an unverifiable turn stays as it settled (D16 gone)', async () => {
    const journal = await open('unverifiable')
    await JOURNAL_SESSION_STATE_CORPUS['unverifiable turn'](journal)
    expect(storedStatus('unverifiable')).toMatchObject({ lifecycle: 'idle' })
    expect(selected('unverifiable')).toBe(false)
  })

  it('selects a chat whose only debt is a queued leftover, and settles it (T15b)', async () => {
    const writer = await open('queued')
    await JOURNAL_SESSION_STATE_CORPUS['queued leftover'](writer)
    await writer.close()
    const journal = await open('queued')
    expect(storedStatus('queued')).toMatchObject({ lifecycle: 'idle', queuedSends: 1 })
    const plan = planOpenSettlement(journal, null)
    expect(plan.leftoverQueued).toEqual(['send-queued'])

    await appendOpenSettlement(journal, plan, CORPUS_FENCE, (error) => {
      throw error
    })

    expect(journal.submission('send-queued')).toMatchObject({ dispatchState: 'rejected' })
    expect(storedStatus('queued')).toMatchObject({ queuedSends: 0, summary: { status: 'idle' } })
  })
})

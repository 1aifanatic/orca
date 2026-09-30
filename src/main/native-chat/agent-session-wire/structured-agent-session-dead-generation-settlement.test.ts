import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  agentSessionFailureFact,
  MAX_PROVIDER_DIAGNOSTIC_CHARS,
  providerDiagnostic
} from '../../../shared/agent-session-failure'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { structuredAgentSessionStartFailure } from './structured-agent-session-failure-text'
import {
  recordStructuredAgentSessionStartFailure,
  structuredAgentSessionStartFailureRow
} from './structured-agent-session-start-failure-row'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStructuredAgentSessionDeadGeneration,
  unfinishedStructuredAgentSessionWorkWasInterrupted
} from './structured-agent-session-dead-generation-settlement'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

const UNEXPECTED_PROVIDER_EXIT_OUTCOME =
  'The agent stopped while this response was in progress. You can continue in this conversation.'

const SESSION = 'session-dead-generation'
const START_ROW = `orca:${encodeURIComponent('start-failure:generation-1')}`
const THREAD = 'thread-1'
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-dead-generation-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    database: openTestJournalHostDatabase(root),
    now: () => 1_000
  })
})

afterEach(async () => {
  await journal.close()
  await rm(root, { recursive: true, force: true })
})

async function seedUnfinishedWork(): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: 'client-1',
    payloadFingerprint: 'fingerprint',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'keep going' }] },
    fence: 7
  })
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
    { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'running' },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 3 },
    {
      kind: 'question',
      question: 'Which target?',
      options: [{ id: 'web', label: 'Web' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 4 },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 900 },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

describe('dead structured-session generation settlement', () => {
  it('settles probe-proven work as unverifiable without a technical chat row or fake end time', async () => {
    await seedUnfinishedWork()

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 8,
        settlementId: `restart-eviction:${SESSION}:8`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'unverifiable' },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toBe(true)

    const snapshot = journal.snapshot()
    expect(snapshot.submissions).toEqual([
      expect.objectContaining({ clientMessageId: 'client-1', dispatchState: 'unknown' })
    ])
    expect(snapshot.items.map((item) => item.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tool-call', state: 'failed' }),
        expect.objectContaining({
          kind: 'approval',
          resolution: expect.objectContaining({ state: 'cancelled' })
        }),
        expect.objectContaining({
          kind: 'question',
          resolution: expect.objectContaining({ state: 'cancelled' })
        }),
        { kind: 'turn', turnId: 'turn-1', state: 'unverifiable', startedAt: 900 }
      ])
    )
    expect(snapshot.items.some((item) => item.body.kind === 'status')).toBe(false)
  })

  it('adds one actionable outcome for observed active-work failure and is idempotent', async () => {
    await seedUnfinishedWork()
    const input = {
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `provider-exit:${SESSION}:7:generation-1`,
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'interrupted' as const, completedAt: 1_000 },
      showUnexpectedExitOutcome: true
    }

    await expect(settleStructuredAgentSessionDeadGeneration(input)).resolves.toBe(true)
    const settledCursor = journal.cursor()
    await expect(settleStructuredAgentSessionDeadGeneration(input)).resolves.toBe(true)

    expect(journal.cursor()).toEqual(settledCursor)
    expect(
      journal
        .snapshot()
        .items.filter(
          (item) =>
            item.body.kind === 'status' && item.body.text === UNEXPECTED_PROVIDER_EXIT_OUTCOME
        )
    ).toHaveLength(1)
  })

  it('keeps a stderr wall out of the sentence, as a bounded detail for a log', async () => {
    await seedUnfinishedWork()

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `provider-exit:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: true,
        exitFailure: agentSessionFailureFact('providerExited', {
          detail: providerDiagnostic('stack frame '.repeat(4_000), 'log')
        })
      })
    ).resolves.toBe(true)

    const statuses = journal
      .snapshot()
      .items.flatMap((item) => (item.body.kind === 'status' ? [item.body] : []))
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.text).toBe(UNEXPECTED_PROVIDER_EXIT_OUTCOME)
    expect(statuses[0]?.failure?.kind).toBe('providerExited')
    expect(statuses[0]?.failure?.detail?.audience).toBe('log')
    expect(statuses[0]?.failure?.detail?.text.length).toBe(MAX_PROVIDER_DIAGNOSTIC_CHARS)
  })

  it("words Orca's own fault as Orca's, never as the provider stopping", async () => {
    await seedUnfinishedWork()

    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `provider-exit:${SESSION}:7:generation-1`,
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'interrupted', completedAt: 1_000 },
      showUnexpectedExitOutcome: true,
      // Orca stopped the provider because its own journal failed.
      exitFailure: agentSessionFailureFact('hostFault')
    })

    const statuses = journal
      .snapshot()
      .items.flatMap((item) => (item.body.kind === 'status' ? [item.body] : []))
    expect(statuses).toEqual([
      {
        kind: 'status',
        text: "Orca ran into a problem, so this didn't go through. Try again.",
        failure: { kind: 'hostFault' },
        tone: 'error'
      }
    ])
  })

  it('retries an already settled expected close without writing through a closed journal gate', async () => {
    const settledItem: AgentJournalRenderItem = {
      itemId: 'codex:thread-1:turn-1:0',
      revision: 2,
      sequence: 2,
      observedAt: 1_000,
      body: {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'interrupted',
        completedAt: 1_000
      }
    }
    const settledSnapshot = journal.snapshot()
    const closedJournal: Pick<
      AgentSessionJournal,
      | 'snapshot'
      | 'submissions'
      | 'markPendingSubmissionsUnknown'
      | 'rejectPendingSubmissions'
      | 'rejectQueuedSubmissions'
      | 'appendLifecycleBatch'
    > = {
      snapshot: () => ({
        ...settledSnapshot,
        items: [settledItem]
      }),
      submissions: () => [],
      markPendingSubmissionsUnknown: async () => {
        throw new Error('journal_closed')
      },
      rejectPendingSubmissions: async () => {
        throw new Error('journal_closed')
      },
      rejectQueuedSubmissions: async () => {
        throw new Error('journal_closed')
      },
      appendLifecycleBatch: async () => {
        throw new Error('journal_closed')
      }
    }

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal: closedJournal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `expected-close:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toBe(true)
  })

  it('settles a live unknown submission even when no unfinished item remains', async () => {
    await journal.appendSubmission({
      clientMessageId: 'client-unknown',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'did this land?' }] },
      fence: 7
    })
    await journal.resolveDispatch({
      clientMessageId: 'client-unknown',
      state: 'unknown',
      reason: 'provider write outcome unknown',
      fence: 7
    })

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `expected-close:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toBe(true)

    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-unknown',
        dispatchState: 'unknown',
        recovered: true,
        reason: 'provider write outcome unknown'
      })
    ])
  })

  it('rejects a send a child that never started left pending with its diagnostic, in words', async () => {
    await journal.appendSubmission({
      clientMessageId: 'client-held',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello?' }] },
      fence: 7
    })

    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `provider-exit:${SESSION}:7:generation-1`,
      pendingSubmissionReason: 'provider_closed_before_acknowledgement',
      verdict: { state: 'interrupted', completedAt: 1_000 },
      exitFailure: agentSessionFailureFact('providerExited', {
        detail: providerDiagnostic('code 1\nnot signed in', 'log')
      }),
      exitedDuringStartup: { generation: 'generation-1' }
    })

    // The sentence is Orca's; the stderr the exit carried rides as a log detail only. The message
    // names the start, the row's own key; the row's fact is only the failure.
    const reason = 'The agent stopped before it finished starting. Send your message to try again.'
    const rejection = {
      kind: 'providerStartFailed',
      detail: { text: 'code 1\nnot signed in', audience: 'log' }
    }
    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-held',
        dispatchState: 'rejected',
        reason,
        rejection,
        rejectedByStartKey: 'generation-1'
      })
    ])
    expect(journal.itemBody(START_ROW)).toEqual({
      kind: 'status',
      text: reason,
      tone: 'error',
      failure: rejection
    })
  })

  // An earlier report of the same start wrote its row first; its words are the start's.
  it("rejects a send the start left pending in the start's row's words, leaving the row", async () => {
    const first = agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
      surface: 'rejection'
    })
    const row = structuredAgentSessionStartFailureRow('generation-1', first)
    await journal.appendLifecycleBatch({
      settlementId: 'start-failure:generation-1',
      fence: 7,
      recovered: true,
      mutations: [row]
    })
    const written = journal.itemBody(START_ROW)
    await journal.appendSubmission({
      clientMessageId: 'client-held',
      payloadFingerprint: 'fingerprint',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello?' }] },
      fence: 7
    })

    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 7,
      settlementId: `provider-exit:${SESSION}:7:generation-1`,
      pendingSubmissionReason: 'provider_closed_before_acknowledgement',
      verdict: { state: 'interrupted', completedAt: 1_000 },
      exitFailure: agentSessionFailureFact('providerExited'),
      exitedDuringStartup: { generation: 'generation-1' }
    })

    expect(journal.submissions()).toEqual([
      expect.objectContaining({
        clientMessageId: 'client-held',
        dispatchState: 'rejected',
        reason: first.reason,
        rejection: { kind: 'notSignedIn' },
        rejectedByStartKey: 'generation-1'
      })
    ])
    expect(journal.itemBody(START_ROW)).toEqual(written)
  })

  // The exit and the delivery loop each report one start: the exit what the child was handed, the
  // loop what is still queued. Whichever reports first writes the start's row; both reject in it.
  describe('a start that failed with one message handed over and one still queued', () => {
    const START_KEY = 'generation-1'
    const loopFailure = structuredAgentSessionStartFailure({
      failure: agentSessionFailureFact('hostStopped')
    })

    async function handedOverAndQueued(): Promise<void> {
      for (const clientMessageId of ['client-handed', 'client-queued']) {
        await journal.appendSubmission({
          clientMessageId,
          payloadFingerprint: 'fingerprint',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: clientMessageId }]
          },
          fence: 7,
          handoverRecorded: true
        })
      }
      await journal.resolveDispatch({
        clientMessageId: 'client-handed',
        state: 'pending',
        fence: 7,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    }

    function settleExit(): Promise<boolean> {
      return settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `provider-exit:${SESSION}:7:${START_KEY}`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        exitFailure: agentSessionFailureFact('notSignedIn'),
        exitedDuringStartup: { generation: START_KEY }
      })
    }

    function reportFromLoop(): Promise<void> {
      return recordStructuredAgentSessionStartFailure(
        { journal, fence: 7 },
        { startKey: START_KEY, ...loopFailure }
      )
    }

    function startRows(): unknown[] {
      return journal
        .snapshot()
        .items.filter((item) =>
          item.itemId.startsWith(`orca:${encodeURIComponent('start-failure:')}`)
        )
    }

    it.each([
      ['the exit first', [settleExit, reportFromLoop]],
      ['the delivery loop first', [reportFromLoop, settleExit]]
    ] as const)('writes one row and rejects both in its words, %s', async (_order, reports) => {
      await handedOverAndQueued()

      for (const report of reports) {
        await report()
      }

      expect(startRows()).toHaveLength(1)
      const row = journal.itemBody(START_ROW)
      if (row?.kind !== 'status') {
        throw new Error('no start row')
      }
      expect(journal.submissions()).toEqual(
        ['client-handed', 'client-queued'].map((clientMessageId) =>
          expect.objectContaining({
            clientMessageId,
            dispatchState: 'rejected',
            reason: row.text,
            rejection: row.failure,
            rejectedByStartKey: START_KEY
          })
        )
      )
    })

    // Its messages were never handed to this child, so the start is the loop's to report.
    it('leaves the row to the delivery loop when the exit rejected nothing it was handed', async () => {
      await journal.appendSubmission({
        clientMessageId: 'client-queued',
        payloadFingerprint: 'fingerprint',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello?' }] },
        fence: 7,
        handoverRecorded: true
      })

      // As the exit of a start always settles: a failed start says why.
      await settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `provider-exit:${SESSION}:7:${START_KEY}`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: true,
        exitFailure: agentSessionFailureFact('notSignedIn'),
        exitedDuringStartup: { generation: START_KEY }
      })

      expect(startRows()).toEqual([])
      expect(journal.submissions()).toEqual([
        expect.objectContaining({ clientMessageId: 'client-queued', dispatchState: 'pending' })
      ])
    })
  })

  it("keeps a subagent's settled rows the subagent's, in one batch and after a reopen", async () => {
    // One batch settles rows several agents wrote and names none of them. Each
    // row keeps the producer its first write named, including after a replay.
    const child = { agentId: 'thread-child', producerKind: 'agent' as const }
    const childCall = {
      provider: 'codex' as const,
      threadId: 'thread-child',
      turnId: 'c',
      ordinal: 1
    }
    const childAsk = {
      provider: 'codex' as const,
      threadId: 'thread-child',
      turnId: 'c',
      ordinal: 2
    }
    await seedUnfinishedWork()
    await journal.appendItem(
      childCall,
      { kind: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'running' },
      { fence: 7, ...child, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      childAsk,
      {
        kind: 'approval',
        title: 'Run ls?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 7, ...child, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 8,
      settlementId: `restart-eviction:${SESSION}:8`,
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'unverifiable' },
      showUnexpectedExitOutcome: false
    })
    const settledProducers = (): [string, number, string | undefined][] =>
      journal
        .snapshot()
        .items.map((item): [string, number, string | undefined] => [
          item.body.kind,
          item.revision,
          item.agentId
        ])

    const settled = settledProducers()
    // Every seeded row was revised by the batch, so these are revision-2 producers.
    expect(settled).toEqual([
      ['message', 0, undefined],
      ['tool-call', 2, undefined],
      ['approval', 2, undefined],
      ['question', 2, undefined],
      ['turn', 2, undefined],
      ['tool-call', 2, 'thread-child'],
      ['approval', 2, 'thread-child']
    ])

    await journal.close()
    journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD }
      },
      database: openTestJournalHostDatabase(root),
      now: () => 1_000
    })
    expect(settledProducers()).toEqual(settled)
  })
})

describe('whether a dead generation interrupted anything', () => {
  async function seedIdlePendingApproval(): Promise<void> {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 },
      {
        kind: 'approval',
        title: 'Run command?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
      { kind: 'turn', turnId: 'turn-1', state: 'completed', startedAt: 900, completedAt: 950 },
      { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }

  it('says nothing was interrupted when the provider died waiting on an approval', async () => {
    await seedIdlePendingApproval()
    const before = captureUnfinishedStructuredAgentSessionWork(journal)

    expect(unfinishedStructuredAgentSessionWorkWasInterrupted(before, journal, 1_000)).toBe(false)
  })

  it('still reports an interruption when a turn was running', async () => {
    await seedUnfinishedWork()
    const before = captureUnfinishedStructuredAgentSessionWork(journal)

    expect(unfinishedStructuredAgentSessionWorkWasInterrupted(before, journal, 1_000)).toBe(true)
  })

  it('cancels the idle prompt without claiming a response was in progress', async () => {
    await seedIdlePendingApproval()

    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 7,
        settlementId: `provider-exit:${SESSION}:7:generation-1`,
        pendingSubmissionReason: 'provider_exited_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_000 },
        showUnexpectedExitOutcome: unfinishedStructuredAgentSessionWorkWasInterrupted(
          captureUnfinishedStructuredAgentSessionWork(journal),
          journal,
          1_000
        )
      })
    ).resolves.toBe(true)

    const snapshot = journal.snapshot()
    expect(snapshot.items.some((item) => item.body.kind === 'status')).toBe(false)
    expect(snapshot.items.map((item) => item.body)).toContainEqual(
      expect.objectContaining({
        kind: 'approval',
        resolution: expect.objectContaining({ state: 'cancelled' })
      })
    )
  })
})

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  codexSubagentGroupBody,
  codexSubagentGroupIdentity
} from '../../codex/codex-subagent-roster'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import {
  settleStaleStructuredAgentSessionState,
  UNEXPECTED_PROVIDER_EXIT_OUTCOME
} from './structured-agent-session-dead-generation-settlement'
import {
  runningTurnLifecycleRevisions,
  turnVerdictFromDeathEvidence,
  UNVERIFIABLE_TURN_VERDICT
} from './structured-agent-session-stale-turn-verdict'

const THREAD = 'thread-1'
const RUNNING_IDENTITY = {
  provider: 'codex' as const,
  threadId: THREAD,
  turnId: 'turn-2',
  ordinal: 0
}

function lifecycleItem(
  turnId: string,
  state: 'running' | 'completed',
  sequence: number,
  extra: { startedAt?: number; completedAt?: number } = {}
): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({ provider: 'codex', threadId: THREAD, turnId, ordinal: 0 }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId, state, ...extra }
  }
}

/** The status-form carrier an older host wrote; still read, never written back. */
function legacyLifecycleItem(turnId: string, startedAt: number): AgentJournalRenderItem {
  return {
    ...lifecycleItem(turnId, 'running', 2),
    body: {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId, state: 'running', startedAt }
    }
  }
}

function promptItem(state: 'pending' | 'resolved', sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: `approval-${state}`
    }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [],
      resolution: {
        state,
        selectedOptionId: state === 'resolved' ? 'allow' : null,
        resolvedBy: state === 'resolved' ? 'client-1' : null,
        resolvedAt: state === 'resolved' ? 10 : null
      }
    }
  }
}

describe('turn verdict from death evidence', () => {
  const lastLiveAt = (at: number) => ({ lastLiveActivityAt: () => at })

  it('ends a watched exit at the exit', () => {
    expect(
      turnVerdictFromDeathEvidence(
        { kind: 'exit-observed', detail: 'exit', observedAt: 500 },
        lastLiveAt(300)
      )
    ).toEqual({ state: 'interrupted', completedAt: 500 })
  })

  it.each(['pid-absent', 'identity-mismatch'] as const)(
    'ends a %s proof an older build recorded at the last row the journal saw live, not at the probe',
    (kind) => {
      // Probed at 9000, long after the crash: the downtime is never counted as work.
      expect(
        turnVerdictFromDeathEvidence({ kind, detail: 'gone', observedAt: 9_000 }, lastLiveAt(300))
      ).toEqual({ state: 'interrupted', completedAt: 300 })
      // A live row stamped after the probe cannot outlast it, and no live row leaves only the probe.
      for (const lastLive of [9_500, 0]) {
        expect(
          turnVerdictFromDeathEvidence(
            { kind, detail: 'gone', observedAt: 9_000 },
            lastLiveAt(lastLive)
          )
        ).toEqual({ state: 'interrupted', completedAt: 9_000 })
      }
    }
  )

  it('ends a probe-proven death at the later of the last renewal and the last live row', () => {
    const proof = (lastProvenAliveAt: number) => ({
      kind: 'pid-absent' as const,
      detail: 'gone',
      observedAt: 9_000,
      lastProvenAliveAt
    })
    // A silent tool run: the renewal saw the child working long after its last row.
    expect(turnVerdictFromDeathEvidence(proof(8_000), lastLiveAt(300))).toEqual({
      state: 'interrupted',
      completedAt: 8_000
    })
    expect(turnVerdictFromDeathEvidence(proof(8_000), lastLiveAt(0))).toEqual({
      state: 'interrupted',
      completedAt: 8_000
    })
    // A chatty provider: its last row is the tighter bound.
    expect(turnVerdictFromDeathEvidence(proof(200), lastLiveAt(300))).toEqual({
      state: 'interrupted',
      completedAt: 300
    })
    // Neither bound outlasts the probe.
    expect(turnVerdictFromDeathEvidence(proof(9_500), lastLiveAt(300))).toEqual({
      state: 'interrupted',
      completedAt: 9_000
    })
  })

  it('ends a watched exit at the exit even when a renewal is recorded', () => {
    expect(
      turnVerdictFromDeathEvidence(
        { kind: 'exit-observed', detail: 'exit', observedAt: 500, lastProvenAliveAt: 400 },
        lastLiveAt(300)
      )
    ).toEqual({ state: 'interrupted', completedAt: 500 })
  })

  it('leaves a release nothing proved unverifiable', () => {
    expect(turnVerdictFromDeathEvidence(null, lastLiveAt(300))).toEqual({ state: 'unverifiable' })
    expect(turnVerdictFromDeathEvidence(undefined, lastLiveAt(300))).toEqual({
      state: 'unverifiable'
    })
  })
})

describe('running turn lifecycle revisions', () => {
  it('revises only running rows in place and carries an end time only for an observed exit', () => {
    const items = [
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 }),
      // A stray end on a running row is never carried into the verdict.
      lifecycleItem('turn-2', 'running', 2, { startedAt: 30, completedAt: 99 })
    ]
    expect(runningTurnLifecycleRevisions(items, { state: 'interrupted', completedAt: 40 })).toEqual(
      [
        {
          kind: 'item',
          identity: RUNNING_IDENTITY,
          body: {
            kind: 'turn',
            turnId: 'turn-2',
            state: 'interrupted',
            startedAt: 30,
            completedAt: 40
          }
        }
      ]
    )
    expect(runningTurnLifecycleRevisions(items, { state: 'unverifiable' })).toEqual([
      expect.objectContaining({
        body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
      })
    ])
  })

  it('keeps every field it does not own when the host settles a running row', () => {
    const contextUsage = {
      used: {
        kind: 'estimate' as const,
        usage: {
          inputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 90_000,
          outputTokens: 5
        },
        capturedAt: 35
      }
    }
    const running = lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
    const body = {
      ...running.body,
      requestedAt: 29,
      userItemId: 'user-2',
      contextUsage,
      // A field a newer build wrote: the verdict does not own it, so it survives.
      laterField: { kept: true },
      outcome: 'success' as const,
      durationMs: 7
    }
    const items: AgentJournalRenderItem[] = [{ ...running, body }]
    const kept = {
      kind: 'turn',
      turnId: 'turn-2',
      startedAt: 30,
      requestedAt: 29,
      userItemId: 'user-2',
      contextUsage,
      laterField: { kept: true }
    }
    expect(
      runningTurnLifecycleRevisions(items, { state: 'interrupted', completedAt: 40 })[0]
    ).toMatchObject({ body: { ...kept, state: 'interrupted', completedAt: 40 } })
    const unverifiable = runningTurnLifecycleRevisions(items, UNVERIFIABLE_TURN_VERDICT)[0]
    expect(unverifiable?.kind === 'item' ? unverifiable.body : null).toEqual({
      ...kept,
      state: 'unverifiable'
    })
  })

  it('revises a legacy status-form running row from an older host into a typed turn', () => {
    expect(
      runningTurnLifecycleRevisions([legacyLifecycleItem('turn-2', 30)], { state: 'unverifiable' })
    ).toEqual([
      {
        kind: 'item',
        identity: RUNNING_IDENTITY,
        body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
      }
    ])
  })

  it('skips rows without a parseable identity', () => {
    const item = { ...lifecycleItem('turn-2', 'running', 2), itemId: 'not-an-item-key' }
    expect(runningTurnLifecycleRevisions([item], { state: 'unverifiable' })).toEqual([])
  })
})

describe('stale session state on a cold acquire', () => {
  function journalWith(items: AgentJournalRenderItem[]) {
    const appendLifecycleBatch = vi.fn(async () => ({ epoch: 'epoch-1', sequence: 9 }))
    const journal = {
      snapshot: () => ({ items }),
      cursor: () => ({ epoch: 'epoch-1', sequence: 8 }),
      appendLifecycleBatch
    } as unknown as AgentSessionJournal
    return { journal, appendLifecycleBatch }
  }

  it('marks a running row from the dead generation unverifiable without an end time', async () => {
    const { journal, appendLifecycleBatch } = journalWith([
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 }),
      lifecycleItem('turn-2', 'running', 2, { startedAt: 30 })
    ])

    await expect(
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })
    ).resolves.toBe(1)

    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: 'stale-session:session-1:14:generation-2',
      fence: 14,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: RUNNING_IDENTITY,
          body: { kind: 'turn', turnId: 'turn-2', state: 'unverifiable', startedAt: 30 }
        }
      ]
    })
  })

  it('cancels only prompts whose callbacks were lost with the prior owner', async () => {
    const pending = promptItem('pending', 1)
    const resolved = promptItem('resolved', 2)
    const { journal, appendLifecycleBatch } = journalWith([pending, resolved])

    await expect(
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })
    ).resolves.toBe(1)

    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: 'stale-session:session-1:14:generation-2',
      fence: 14,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: {
            provider: 'legacy',
            agent: 'codex',
            sessionId: 'session-1',
            recordId: 'approval-pending'
          },
          body: {
            ...pending.body,
            resolution: {
              state: 'cancelled',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          }
        }
      ]
    })
  })

  it("cancels a subagent's lost prompt as the subagent's, and the session's own as its own", async () => {
    // The sweep names no producer, so each cancelled row keeps the one it had.
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => 1_000
      })
      const child = { agentId: 'thread-child', producerKind: 'agent' as const }
      const { body } = promptItem('pending', 1)
      const prompt = (threadId: string) => ({
        provider: 'codex' as const,
        threadId,
        turnId: 'turn-1',
        ordinal: 1
      })
      await journal.appendItem(prompt('thread-child'), body, { fence: 1, ...child })
      await journal.appendItem(prompt(THREAD), body, { fence: 1 })

      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: 'generation-2',
        deathEvidence: null
      })

      expect(
        journal.snapshot().items.map((item) => [item.body.kind, item.revision, item.agentId])
      ).toEqual([
        ['approval', 2, 'thread-child'],
        ['approval', 2, undefined]
      ])
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ends a probe-proven turn at its last live row, which a revised item does not carry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    let now = 100
    try {
      const journal = await journals.open({
        identity: {
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          hostId: 'local',
          agent: 'codex',
          providerHandle: { kind: 'codex', threadId: THREAD }
        },
        journalDir: root,
        now: () => now
      })
      const command = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
      const shell = { kind: 'tool-call' as const, name: 'shell', input: { command: 'pnpm test' } }
      await journal.appendItem(
        { ...command, ordinal: 0 },
        { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 100 },
        { fence: 1 }
      )
      now = 200
      await journal.appendItem(command, { ...shell, state: 'running' }, { fence: 1 })
      // Output streamed until 700: a revision, so the item still reads as first seen at 200.
      now = 700
      await journal.appendItem(
        command,
        { ...shell, input: { command: 'pnpm test', streamed: 'ok' }, state: 'running' },
        { fence: 1 }
      )
      // Crash reconciliation is Orca writing, not the provider working.
      now = 900
      await journal.appendLifecycleBatch({
        settlementId: 'earlier-recovery',
        fence: 1,
        recovered: true,
        mutations: [
          {
            kind: 'item',
            identity: { provider: 'orca', clientMessageId: 'earlier-recovery' },
            body: { kind: 'status', text: 'recovered' }
          }
        ]
      })
      now = 9_000

      await settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: 'generation-2',
        deathEvidence: {
          kind: 'pid-absent',
          detail: 'recorded pid absent on host',
          observedAt: 9_000
        }
      })

      const items = journal.snapshot().items
      expect(items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)).toMatchObject({
        state: 'interrupted',
        completedAt: 700
      })
      // The probe's detail is Orca's, so the row carries none.
      expect(
        items.flatMap((item) => (item.body.kind === 'status' ? [item.body.text] : []))
      ).toEqual(['recovered', UNEXPECTED_PROVIDER_EXIT_OUTCOME])
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not count the reopen settling a roster the crashed host left working as activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
    const journals = createTrackedJournalOpener()
    let now = 100
    const identity = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: { kind: 'codex' as const, threadId: THREAD }
    }
    try {
      const live = await journals.open({ identity, journalDir: root, now: () => now })
      await live.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 },
        { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 100 },
        { fence: 1 }
      )
      now = 200
      const groupId = `${THREAD}:turn-1`
      await live.appendItem(
        codexSubagentGroupIdentity(groupId),
        codexSubagentGroupBody(groupId, [
          { id: 'a', label: 'explore', state: 'working', startedAt: 200 }
        ]),
        { fence: 1 }
      )
      await live.close()
      // Relaunched long after the crash: the open retires the roster, then the probe proves death.
      now = 9_000
      const reopened = await journals.open({ identity, journalDir: root, now: () => now })

      await settleStaleStructuredAgentSessionState({
        journal: reopened,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: 'generation-2',
        deathEvidence: { kind: 'pid-absent', detail: 'gone', observedAt: 8_500 }
      })

      expect(
        reopened
          .snapshot()
          .items.map((item) => readAgentJournalTurn(item.body))
          .find(Boolean)
      ).toMatchObject({ state: 'interrupted', completedAt: 200 })
    } finally {
      await journals.closeAll()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes nothing when no turn is running and keys on the journal position without a generation', async () => {
    const idle = journalWith([
      lifecycleItem('turn-1', 'completed', 1, { startedAt: 10, completedAt: 20 })
    ])
    await expect(
      settleStaleStructuredAgentSessionState({
        journal: idle.journal,
        sessionId: 'session-1',
        fence: 14,
        acquisitionGeneration: null,
        deathEvidence: null
      })
    ).resolves.toBe(0)
    expect(idle.appendLifecycleBatch).not.toHaveBeenCalled()

    const running = journalWith([lifecycleItem('turn-2', 'running', 2)])
    await settleStaleStructuredAgentSessionState({
      journal: running.journal,
      sessionId: 'session-1',
      fence: 14,
      acquisitionGeneration: null,
      deathEvidence: null
    })
    expect(running.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: 'stale-session:session-1:14:seq-8' })
    )
  })
})

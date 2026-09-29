import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { projectStructuredAgentSessionStatus } from '../../../shared/structured-agent-session-projection'
import { releaseStructuredAgentSessionUnansweredDispatches } from './structured-agent-session-unanswered-dispatch-release'

const FENCE = 7

function submission(over: Partial<AgentJournalSubmission>): AgentJournalSubmission {
  return {
    clientMessageId: 'm-1',
    fence: FENCE,
    payloadFingerprint: 'fp',
    dispatchState: 'unknown',
    providerItemId: null,
    reason: 'provider_write_outcome_unknown: timeout',
    submittedAt: 1,
    resolvedAt: 2,
    ...over
  }
}

type ReleaseContext = Parameters<typeof releaseStructuredAgentSessionUnansweredDispatches>[0]
type ReleaseSession = NonNullable<ReturnType<ReleaseContext['sessions']['get']>>
type ResolveDispatchInput = Parameters<ReleaseSession['journal']['resolveDispatch']>[0]
type LifecycleBatchInput = Parameters<ReleaseSession['journal']['appendLifecycleBatch']>[0]

function contextWith(submissions: AgentJournalSubmission[]) {
  const resolved: ResolveDispatchInput[] = []
  const batches: LifecycleBatchInput[] = []
  const writes: string[] = []
  const journal = {
    submissions: () => submissions,
    resolveDispatch: vi.fn(async (input: ResolveDispatchInput) => {
      resolved.push(input)
      writes.push(`dispatch:${input.clientMessageId}`)
      return { epoch: 'e', sequence: 1 }
    }),
    appendLifecycleBatch: vi.fn(async (input: LifecycleBatchInput) => {
      batches.push(input)
      writes.push(`batch:${input.settlementId}`)
      return { epoch: 'e', sequence: 1 }
    })
  }
  // The mutation reads only the journal calls above, the record fence and the record's agent.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field the mutation reads is supplied here; the rest of the session and the record is unreachable from it.
  const context = {
    sessions: new Map([['s-1', { journal }]]),
    deps: {
      store: { getRecord: () => ({ provider: 'codex', lease: { runtimeFence: FENCE } }) }
    }
  } as unknown as ReleaseContext
  return { context, resolved, batches, writes, journal }
}

function rowsOf(batches: LifecycleBatchInput[]) {
  return batches.flatMap((batch) =>
    batch.mutations.flatMap((mutation) =>
      mutation.kind === 'item' ? [{ identity: mutation.identity, body: mutation.body }] : []
    )
  )
}

describe('releasing dispatches the provider can no longer answer', () => {
  it('retires a live unknown so the session stops reading working', async () => {
    const live = [submission({})]
    // POSITIVE CONTROL: this is the latch being dissolved.
    expect(projectStructuredAgentSessionStatus([], live, FENCE)).toBe('working')
    const { context, resolved } = contextWith(live)

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved).toEqual([
      {
        clientMessageId: 'm-1',
        state: 'unknown',
        // The sharper earlier fact survives, exactly as restart recovery keeps it.
        reason: 'provider_write_outcome_unknown: timeout',
        fence: FENCE,
        recovered: true
      }
    ])
    expect(projectStructuredAgentSessionStatus([], [submission({ recovered: true })], FENCE)).toBe(
      'idle'
    )
  })

  it('says once, in a session row, that the agent did not respond, before retiring the sends', async () => {
    const { context, batches, writes } = contextWith([
      submission({}),
      submission({ clientMessageId: 'm-2' })
    ])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(rowsOf(batches)).toEqual([
      {
        identity: { provider: 'orca', clientMessageId: 'provider-idle:s-1:m-1' },
        body: {
          kind: 'status',
          tone: 'notice',
          text: "Codex didn't respond to your last message. Send a message to continue.",
          failure: { kind: 'messageUnanswered' }
        }
      }
    ])
    // Row first: a retry after a failed retire revises this row instead of leaving none.
    expect(writes).toEqual(['batch:provider-idle:s-1:m-1', 'dispatch:m-1', 'dispatch:m-2'])
  })

  it('keeps one row when a retire fails and the next idle retries it', async () => {
    const live = [submission({})]
    const { context, batches, journal } = contextWith(live)
    journal.resolveDispatch.mockRejectedValueOnce(new Error('journal write failed'))
    const release = () =>
      releaseStructuredAgentSessionUnansweredDispatches(context, {
        sessionId: 's-1',
        reason: 'provider_idle_before_acknowledgement'
      })

    await expect(release()).rejects.toThrow('journal write failed')
    await release()

    const ids = rowsOf(batches).map((row) => row.identity)
    expect(ids).toHaveLength(2)
    // The same identity revises the one row in place.
    expect(new Set(ids.map((id) => JSON.stringify(id))).size).toBe(1)
  })

  it('leaves one row in the journal however often the provider goes idle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-idle-release-'))
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: 's-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      journalDir: root,
      now: () => 1_000
    })
    try {
      await journal.appendSubmission({
        clientMessageId: 'm-1',
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
        fence: FENCE
      })
      await journal.resolveDispatch({
        clientMessageId: 'm-1',
        state: 'unknown',
        reason: 'turn start timed out',
        fence: FENCE
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mutation reads only the session's journal and the record's fence and agent, all supplied.
      const context = {
        sessions: new Map([['s-1', { journal }]]),
        deps: {
          store: { getRecord: () => ({ provider: 'codex', lease: { runtimeFence: FENCE } }) }
        }
      } as unknown as ReleaseContext
      const release = () =>
        releaseStructuredAgentSessionUnansweredDispatches(context, {
          sessionId: 's-1',
          reason: 'provider_idle_before_acknowledgement'
        })

      await release()
      await release()

      expect(
        journal.snapshot().items.flatMap((item) => (item.body.kind === 'status' ? [item.body] : []))
      ).toEqual([expect.objectContaining({ failure: { kind: 'messageUnanswered' } })])
      expect(journal.submissions()).toEqual([
        expect.objectContaining({ dispatchState: 'unknown', recovered: true })
      ])
    } finally {
      await journal.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never touches a pending send, whose dispatch may still be in flight', async () => {
    const { context, resolved, batches } = contextWith([
      submission({ clientMessageId: 'm-2', dispatchState: 'pending', reason: null })
    ])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved).toEqual([])
    expect(batches).toEqual([])
  })

  it('leaves an already recovered unknown alone, writing no second row', async () => {
    const { context, resolved, batches } = contextWith([submission({ recovered: true })])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved).toEqual([])
    expect(batches).toEqual([])
  })

  it('falls back to the supplied reason when the submission named none', async () => {
    const { context, resolved } = contextWith([submission({ reason: null })])

    await releaseStructuredAgentSessionUnansweredDispatches(context, {
      sessionId: 's-1',
      reason: 'provider_idle_before_acknowledgement'
    })

    expect(resolved[0]).toMatchObject({ reason: 'provider_idle_before_acknowledgement' })
  })
})

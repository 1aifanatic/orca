import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { structuredAgentSessionCompactBody } from './structured-agent-session-command-turn'
import {
  settleStructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExitContext,
  type StructuredAgentSessionChildExitSession
} from './structured-agent-session-child-exit'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 'session-1'
const GENERATION = 'generation-1'
const REASON = 'claude stream-json exited (code 1): session limit reached'
const STARTUP_TEXT = 'Claude stopped before it finished starting. Send your message to try again.'

function startedSession(): StructuredAgentSessionChildExitSession & {
  journal: { appendLifecycleBatch: ReturnType<typeof vi.fn> }
} {
  return {
    child: { generation: GENERATION, fence: 7, phase: 'ready' },
    journal: {
      cursor: () => ({ epoch: 'epoch-1', sequence: 0 }),
      itemBody: () => null,
      // Nothing ran: the start failed before any response or acknowledged prompt.
      snapshot: () => ({ items: [] }),
      appendLifecycleBatch: vi.fn(async () => ({ epoch: 'epoch-1', sequence: 1 })),
      markPendingSubmissionsUnknown: vi.fn(async () => []),
      rejectPendingSubmissions: vi.fn(async () => [])
    }
  }
}

function contextFor(session: StructuredAgentSessionChildExitSession) {
  let record: AgentSessionRecord = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: SESSION,
      runtimeKind: 'native',
      runtimeFence: 7,
      handoffStage: null,
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-1' },
      reservedSpawnToken: 'spawn-1',
      claimStatus: 'live',
      unreconciled: false
    })
  )
  const context: StructuredAgentSessionChildExitContext<typeof session> = {
    logger: recordingStructuredAgentSessionLogger().logger,
    store: {
      getRecord: () => record,
      transitionHandoff: async (
        _sessionId: string,
        transition: (current: AgentSessionRecord) => AgentSessionRecord
      ) => (record = transition(record))
    },
    sessions: new Map([[SESSION, session]]),
    flushLifecycle: async () => ({ ok: true }),
    publishFence: vi.fn(),
    serialize: async <T>(_sessionId: string, task: () => Promise<T>) => task(),
    now: () => 1
  }
  return context
}

const ended = {
  type: 'ended' as const,
  sessionId: SESSION,
  reason: REASON,
  cause: 'unexpected-exit' as const,
  fence: 7,
  acquisitionGeneration: GENERATION
}

describe('a provider that ends before it finished starting', () => {
  it('tells the user why, even with no response in progress', async () => {
    const session = startedSession()

    await settleStructuredAgentSessionChildExit(contextFor(session), {
      ...ended,
      // The adapter typed the start's own failure; the host keeps it rather than reword it.
      failure: { kind: 'notSignedIn' },
      startupUnproven: true
    })

    expect(session.journal.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            // The same row the delivery loop writes for a failed start: an error, keyed by it.
            identity: { provider: 'orca', clientMessageId: `start-failure:${GENERATION}` },
            body: {
              kind: 'status',
              text: 'Claude is not signed in for the selected account. Sign in, then send your message again.',
              tone: 'error',
              failure: { kind: 'notSignedIn' }
            }
          })
        ]
      })
    )
  })

  it('keeps an ordinary idle exit silent', async () => {
    const session = startedSession()

    await settleStructuredAgentSessionChildExit(contextFor(session), ended)

    expect(session.child).toBeNull()
    expect(session.journal.appendLifecycleBatch).not.toHaveBeenCalled()
  })

  it("reads a start that failed off the host's own phase when the provider omits the flag", async () => {
    const session = {
      ...startedSession(),
      child: { generation: GENERATION, fence: 7, phase: 'starting' as const }
    }

    await settleStructuredAgentSessionChildExit(contextFor(session), {
      ...ended,
      failure: { kind: 'providerExited', detail: { text: REASON, audience: 'log' } }
    })

    expect(session.journal.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            // The same row the delivery loop writes for a failed start: an error, keyed by it.
            identity: { provider: 'orca', clientMessageId: `start-failure:${GENERATION}` },
            // The exit's stderr stays out of the sentence, as a log detail beside it.
            body: {
              kind: 'status',
              text: STARTUP_TEXT,
              tone: 'error',
              failure: {
                kind: 'providerStartFailed',
                detail: { text: REASON, audience: 'log' }
              }
            }
          })
        ]
      })
    )
  })

  it('names /compact as the next step when the start that failed was carrying it', async () => {
    const base = startedSession()
    const session = {
      ...base,
      child: { generation: GENERATION, fence: 7, phase: 'starting' as const },
      journal: {
        ...base.journal,
        submissions: () => [{ clientMessageId: 'compact-1', dispatchState: 'pending' as const }],
        itemBody: () => structuredAgentSessionCompactBody()
      }
    }

    await settleStructuredAgentSessionChildExit(contextFor(session), ended)

    const text = 'Claude stopped before it finished starting. Run /compact again.'
    expect(session.journal.rejectPendingSubmissions).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ reason: text })
    )
    expect(session.journal.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [expect.objectContaining({ body: expect.objectContaining({ text }) })]
      })
    )
  })
})

describe('the one row a failed start leaves', () => {
  type Submission = Pick<AgentJournalSubmission, 'clientMessageId' | 'dispatchState'> &
    Partial<AgentJournalSubmission>

  function startingSession(submissions: Submission[], rejectedHere: string[] = []) {
    const base = startedSession()
    return {
      ...base,
      child: { generation: GENERATION, fence: 7, phase: 'starting' as const },
      journal: {
        ...base.journal,
        submissions: () => submissions,
        rejectPendingSubmissions: vi.fn(async () => rejectedHere)
      }
    }
  }

  function rowsWritten(session: ReturnType<typeof startedSession>): unknown[] {
    return session.journal.appendLifecycleBatch.mock.calls.flatMap((call) => {
      const [batch] = call
      // The mock records whatever batch it was given; each names its mutations.
      const mutations: { body?: { kind?: string } }[] = batch.mutations
      return mutations.filter((mutation) => mutation.body?.kind === 'status')
    })
  }

  it("is the exit's for the messages it rejected", async () => {
    const session = startingSession(
      [{ clientMessageId: 'handed-1', dispatchState: 'pending', handedOverAt: 1, fence: 7 }],
      ['handed-1']
    )

    await settleStructuredAgentSessionChildExit(contextFor(session), ended)

    expect(rowsWritten(session)).toEqual([
      expect.objectContaining({
        identity: { provider: 'orca', clientMessageId: `start-failure:${GENERATION}` }
      })
    ])
  })

  it.each<[string, Submission]>([
    [
      'a queued message, which the delivery loop rejects with its own row',
      { clientMessageId: 'queued-1', dispatchState: 'pending', handoverRecorded: true }
    ],
    [
      "a message already rejected as this start, with its writer's row",
      {
        clientMessageId: 'rejected-1',
        dispatchState: 'rejected',
        fence: 7,
        reason: STARTUP_TEXT,
        rejection: { kind: 'providerStartFailed' }
      }
    ]
  ])('is not written again beside %s', async (_case, submission) => {
    const session = startingSession([submission])

    await settleStructuredAgentSessionChildExit(contextFor(session), ended)

    expect(rowsWritten(session)).toEqual([])
  })
})

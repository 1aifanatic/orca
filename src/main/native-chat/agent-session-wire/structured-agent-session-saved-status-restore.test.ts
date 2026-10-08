import { describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionDeathEvidence,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { SavedStructuredSessionStatus } from '../../../shared/structured-agent-session-saved-status'
import {
  restoreSavedStructuredAgentSessionStatuses,
  settledSavedStructuredSessionSummary
} from './structured-agent-session-saved-status-restore'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const FENCE = 7
const DIED_AT = 50_000

function record(
  sessionId: string,
  deathEvidence: AgentSessionDeathEvidence | null = null
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, deathEvidence })),
    conversationName: 'Named on the record'
  }
}

function saved(
  sessionId: string,
  fields: Partial<AgentSessionStatusSummary> = {},
  turnFence?: number
): SavedStructuredSessionStatus {
  return {
    summary: {
      sessionId,
      workspaceId: 'workspace-1',
      agent: 'claude',
      status: 'working',
      latestPrompt: 'refactor the parser',
      conversationName: 'Stale saved name',
      updatedAt: 40_000,
      statusStartedAt: 39_000,
      ...fields
    },
    ...(turnFence === undefined ? {} : { turnFence })
  }
}

const exited: AgentSessionDeathEvidence = {
  kind: 'exit-observed',
  detail: 'exit observed',
  observedAt: DIED_AT,
  ownerFence: FENCE
}

describe('a saved status, as a restart shows it', () => {
  it.each(['working', 'attention'] as const)(
    'reads Interrupted when it was %s and the death of the turn owner is proven',
    (status) => {
      const settled = settledSavedStructuredSessionSummary(
        saved('chat', { status }, FENCE),
        record('chat', exited)
      )
      expect(settled).toMatchObject({
        status: 'idle',
        turnOutcome: 'interruption',
        statusStartedAt: DIED_AT
      })
    }
  )

  it.each([
    ['no proof at all', null],
    ['a proof about another owner', { ...exited, ownerFence: FENCE + 1 }]
  ] as const)("reads Couldn't confirm with %s, never working or waiting", (_why, evidence) => {
    for (const status of ['working', 'attention'] as const) {
      const settled = settledSavedStructuredSessionSummary(
        saved('chat', { status }, FENCE),
        record('chat', evidence)
      )
      expect(settled.status).toBe('idle')
      expect(settled.turnOutcome).toBe('unconfirmed')
      expect(settled.statusStartedAt).toBeUndefined()
    }
  })

  it.each(['success', 'failure', 'cancellation', 'interruption', 'unconfirmed'] as const)(
    'keeps a settled %s verdict as it was saved',
    (turnOutcome) => {
      const settled = settledSavedStructuredSessionSummary(
        saved('chat', { status: 'idle', turnOutcome }),
        record('chat', exited)
      )
      expect(settled).toMatchObject({ status: 'idle', turnOutcome, statusStartedAt: 39_000 })
    }
  )

  it('takes its name, agent and workspace from the record, which outlive the save', () => {
    const settled = settledSavedStructuredSessionSummary(
      saved('chat', { status: 'idle', agent: 'codex', workspaceId: 'moved' }),
      record('chat')
    )
    expect(settled).toMatchObject({
      agent: 'claude',
      workspaceId: 'workspace-1',
      conversationName: 'Named on the record'
    })
  })
})

function restoreInput(
  entries: SavedStructuredSessionStatus[],
  records: AgentSessionRecord[],
  listed: string[]
) {
  const log = recordingStructuredAgentSessionLogger()
  return {
    log,
    input: {
      listed,
      saved: entries,
      getRecord: (sessionId: string) =>
        records.find((candidate) => candidate.sessionId === sessionId) ?? null,
      restoreSaved: vi.fn(),
      dropSaved: vi.fn(),
      settle: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      logger: log.logger
    }
  }
}

describe('restoring saved statuses at startup', () => {
  it('shows each listed chat and opens only the ones a restart cut', async () => {
    const { input } = restoreInput(
      [saved('cut', {}, FENCE), saved('idle', { status: 'idle', turnOutcome: 'success' })],
      [record('cut', exited), record('idle')],
      ['cut', 'idle']
    )

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.restoreSaved.mock.calls.map(([summary]) => summary)).toEqual([
      expect.objectContaining({ sessionId: 'cut', status: 'idle', turnOutcome: 'interruption' }),
      expect.objectContaining({ sessionId: 'idle', status: 'idle', turnOutcome: 'success' })
    ])
    expect(input.settle).toHaveBeenCalledExactlyOnceWith(['cut'])
    expect(input.close).not.toHaveBeenCalled()
    expect(input.dropSaved).not.toHaveBeenCalled()
  })

  it('opens nothing when no chat was cut', async () => {
    const { input } = restoreInput([saved('idle', { status: 'idle' })], [record('idle')], ['idle'])

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.settle).not.toHaveBeenCalled()
  })

  it('settles an unlisted cut chat, then closes it and lets its saved status die', async () => {
    const { input } = restoreInput([saved('worker', {}, FENCE)], [record('worker', exited)], [])

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.restoreSaved).not.toHaveBeenCalled()
    expect(input.settle).toHaveBeenCalledExactlyOnceWith(['worker'])
    expect(input.close).toHaveBeenCalledExactlyOnceWith('worker')
    expect(input.dropSaved).toHaveBeenCalledExactlyOnceWith('worker')
    expect(input.settle.mock.invocationCallOrder[0]).toBeLessThan(
      input.close.mock.invocationCallOrder[0]!
    )
  })

  it('drops a saved status nothing lists or whose chat is gone', async () => {
    const { input } = restoreInput(
      [saved('closed', { status: 'idle' }), saved('gone', {}, FENCE)],
      [record('closed')],
      ['gone']
    )

    await restoreSavedStructuredAgentSessionStatuses(input)

    expect(input.dropSaved.mock.calls).toEqual([['closed'], ['gone']])
    expect(input.restoreSaved).not.toHaveBeenCalled()
    expect(input.settle).not.toHaveBeenCalled()
  })

  it('logs a failed settle and close, and still lists the chat', async () => {
    const { input, log } = restoreInput(
      [saved('cut', {}, FENCE), saved('worker', {}, FENCE)],
      [record('cut', exited), record('worker', exited)],
      ['cut']
    )
    input.settle.mockRejectedValueOnce(new Error('disk I/O error'))
    input.close.mockRejectedValueOnce(new Error('disk I/O error'))

    await expect(restoreSavedStructuredAgentSessionStatuses(input)).resolves.toBeUndefined()

    expect(input.restoreSaved).toHaveBeenCalledOnce()
    expect(input.dropSaved).toHaveBeenCalledExactlyOnceWith('worker')
    expect(log.entries.map((entry) => entry.fields.scope)).toEqual([
      'saved-status-settle',
      'saved-status-close'
    ])
  })
})

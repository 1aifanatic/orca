import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('performCancel', () => {
  it('acknowledges only the request and leaves the running lifecycle row intact', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    const lifecycleIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1 }
    )
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      flushStreamedEvents: async () => undefined,
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { kind: 'status', text: 'Cancellation requested.' }
    ])
  })

  it('hands the adapter a live-turn read of the published journal', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-live-turn-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    const lifecycleIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1 }
    )
    let resolveLiveTurnId: (() => string | null) | undefined
    const cancelTurn = vi.fn(
      async (input: Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]) => {
        resolveLiveTurnId = input.resolveLiveTurnId
        return { cancelled: true }
      }
    )
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      flushStreamedEvents: async () => undefined,
      now: () => 1
    }

    await performCancel(ctx, { clientOperationId: 'cancel-live-1', turnId: 'turn-1' })

    expect(resolveLiveTurnId?.()).toBe('turn-1')
    // Re-read, not captured: the turn ending is what the guard has to see.
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Done.',
        turnLifecycle: { turnId: 'turn-1', state: 'completed' }
      },
      { fence: 1 }
    )
    expect(resolveLiveTurnId?.()).toBeNull()
  })

  it('keeps the running lifecycle when cancellation cannot be confirmed', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-unconfirmed-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    await journal.appendItem(
      {
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:turn-1'
      },
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1 }
    )
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: {
        cancelTurn: vi.fn(async () => ({ cancelled: false }))
      } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      flushStreamedEvents: async () => undefined,
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-unconfirmed-1',
      turnId: 'turn-1'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: false } })
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { kind: 'status', text: 'The provider had already finished this turn.' }
    ])
  })

  it('stops background tasks without interrupting the foreground turn or writing a row', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-task-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn, stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      flushStreamedEvents: async () => undefined,
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-background-tasks',
      turnId: 'background-tasks',
      scope: 'background-tasks'
    })

    expect(result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledWith({ sessionId: 'session-1', fence: 1 })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })

  it('routes one background task id without interrupting the foreground turn or writing a row', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-task-targeted-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: { cancelTurn, stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      flushStreamedEvents: async () => undefined,
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-background-task-2',
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-2'
    })

    expect(result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fence: 1,
      taskId: 'task-2'
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })
})

describe('what a conversation Stop reports when the provider stopped nothing', () => {
  async function cancelWith(
    outcome: Awaited<ReturnType<StructuredAgentSessionAdapter['cancelTurn']>>,
    input: { turnId?: string; withdrewQueued?: boolean },
    running = false
  ) {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-report-'))
    const journal = await journals.open({ identity: IDENTITY, journalDir: root })
    if (running) {
      await journal.appendItem(
        {
          provider: 'legacy',
          agent: 'codex',
          sessionId: 'session-1',
          recordId: 'turn-lifecycle:turn-1'
        },
        {
          kind: 'status',
          text: 'Agent is working…',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        },
        { fence: 1 }
      )
    }
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      adapter: {
        acquire: vi.fn(),
        dispatch: vi.fn(),
        closeSession: vi.fn(),
        cancelTurn: vi.fn(async () => outcome),
        answerPrompt: vi.fn(),
        setOption: vi.fn()
      },
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      flushStreamedEvents: async () => undefined,
      now: () => 1
    }
    const result = await performCancel(ctx, { clientOperationId: 'cancel-report-1', ...input })
    const rows = journal
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'status' && !item.body.turnLifecycle ? [item.body.text] : []
      )
    return { cancelled: result.ok && result.value.cancelled, rows }
  }

  it('reports a Stop naming no turn that withdrew what was queued, with nothing left working, as a success', async () => {
    expect(await cancelWith({ cancelled: false }, { withdrewQueued: true })).toEqual({
      cancelled: true,
      rows: []
    })
  })

  it('keeps a Stop naming no turn not cancelled while the journal still reads working', async () => {
    const reported = await cancelWith({ cancelled: false }, { withdrewQueued: true }, true)
    expect(reported.cancelled).toBe(false)
    expect(reported.rows).toHaveLength(1)
    expect(reported.rows).not.toContain('The provider had already finished this turn.')
  })

  it.each([false, true])(
    'says a named Stop the provider left unconfirmed is unconfirmed, not that the turn had finished (withdrew: %s)',
    async (withdrewQueued) => {
      expect(
        await cancelWith(
          { cancelled: false, unconfirmed: true },
          { turnId: 'turn-1', withdrewQueued }
        )
      ).toEqual({ cancelled: false, rows: ['Cancellation was not confirmed.'] })
    }
  )
})

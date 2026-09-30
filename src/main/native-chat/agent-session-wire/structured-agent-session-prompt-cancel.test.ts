import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const PROMPT_IDENTITY = {
  provider: 'codex' as const,
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
}

const journals = createTrackedJournalOpener()
let root: string | null = null

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function pendingPrompt(): Promise<{ journal: AgentSessionJournal; itemId: string }> {
  root = await mkdtemp(join(tmpdir(), 'orca-prompt-cancel-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const item = await journal.appendItem(
    PROMPT_IDENTITY,
    {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  return { journal, itemId: item.itemId }
}

function context(
  journal: AgentSessionJournal,
  cancelTurn: StructuredAgentSessionAdapter['cancelTurn']
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
}

describe('performCancel for a pending prompt', () => {
  it('refuses a stale prompt revision before reaching the provider', async () => {
    const { journal, itemId } = await pendingPrompt()
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))

    const result = await performCancel(context(journal, cancelTurn), {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1',
      prompt: { itemId, expectedRevision: 2 }
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale', currentRevision: 1 }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
  })

  it("records a confirmed cancellation after the prompt's own terminal row", async () => {
    const { journal, itemId } = await pendingPrompt()
    const order: string[] = []
    const cancelTurn = vi.fn(async () => {
      order.push('interrupt')
      const current = journal.snapshot().items.find((item) => item.itemId === itemId)!
      if (current.body.kind !== 'approval') {
        throw new Error('expected approval prompt')
      }
      // The provider's frame, issued during the interrupt and not yet landed when it answers.
      void journal
        .appendItem(
          PROMPT_IDENTITY,
          {
            ...current.body,
            resolution: {
              state: 'cancelled',
              selectedOptionId: null,
              resolvedBy: null,
              resolvedAt: null
            }
          },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        .then(() => order.push('lifecycle'))
      return { cancelled: true }
    })

    await expect(
      performCancel(context(journal, cancelTurn), {
        clientOperationId: 'cancel-1',
        turnId: 'turn-1',
        prompt: { itemId, expectedRevision: 1 }
      })
    ).resolves.toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })

    expect(order).toEqual(['interrupt', 'lifecycle'])
    expect(cancelTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      fence: 1,
      resolveLiveTurnId: expect.any(Function),
      prompt: { itemId }
    })
    const items = journal.snapshot().items
    expect(items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'cancelled' }) }),
      { kind: 'status', text: 'Cancellation requested.' }
    ])
    // Issued after the prompt's terminal row, so it lands after it.
    expect(items[1]!.sequence).toBeGreaterThan(items[0]!.sequence)
  })

  it('keeps the callback answerable when interruption is declined', async () => {
    const { journal, itemId } = await pendingPrompt()

    await expect(
      performCancel(
        context(journal, async () => ({ cancelled: false })),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).resolves.toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: false } })

    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) }),
      { kind: 'status', text: 'The provider had already finished this turn.' }
    ])
  })

  it('propagates an unconfirmed adapter failure and leaves the prompt pending', async () => {
    const { journal, itemId } = await pendingPrompt()

    await expect(
      performCancel(
        context(journal, async () => {
          throw new Error('interrupt receipt lost')
        }),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).rejects.toThrow('interrupt receipt lost')

    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) })
    ])
  })
})

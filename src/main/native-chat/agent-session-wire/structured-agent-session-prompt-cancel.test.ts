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
import {
  answerStructuredAgentSessionPromptOrStop,
  cancelStructuredAgentSessionPrompt
} from './structured-agent-session-prompt-cancel'
import type { AgentSessionPromptRoute } from './structured-agent-session-adapter-stop'

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

async function pendingPrompt(
  options = [{ id: 'allow', label: 'Allow' }]
): Promise<{ journal: AgentSessionJournal; itemId: string }> {
  root = await mkdtemp(join(tmpdir(), 'orca-prompt-cancel-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const item = await journal.appendItem(
    PROMPT_IDENTITY,
    {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options,
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
  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'],
  flushStreamedEvents: () => Promise<void>
): AgentSessionTurnContext {
  return {
    sessionId: 'session-1',
    journal,
    fence: 1,
    adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    flushStreamedEvents,
    now: () => 1
  }
}

describe('performCancel for a pending prompt', () => {
  it('refuses a stale prompt revision before reaching the provider', async () => {
    const { journal, itemId } = await pendingPrompt()
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const flush = vi.fn(async () => undefined)

    const result = await performCancel(context(journal, cancelTurn, flush), {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1',
      prompt: { itemId, expectedRevision: 2 }
    })

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale', currentRevision: 1 }
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('drains terminal lifecycle before recording a confirmed cancellation', async () => {
    const { journal, itemId } = await pendingPrompt()
    const order: string[] = []
    const cancelTurn = vi.fn(async () => {
      order.push('interrupt')
      return { cancelled: true }
    })
    const flush = vi.fn(async () => {
      order.push('lifecycle')
      const current = journal.snapshot().items.find((item) => item.itemId === itemId)!
      if (current.body.kind !== 'approval') {
        throw new Error('expected approval prompt')
      }
      await journal.appendItem(
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
    })

    await expect(
      performCancel(context(journal, cancelTurn, flush), {
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
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'cancelled' }) }),
      { kind: 'status', text: 'Cancellation requested.' }
    ])
  })

  it('keeps the callback answerable when interruption is declined', async () => {
    const { journal, itemId } = await pendingPrompt()
    const flush = vi.fn(async () => undefined)

    await expect(
      performCancel(
        context(journal, async () => ({ cancelled: false }), flush),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).resolves.toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: false } })

    expect(flush).not.toHaveBeenCalled()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) }),
      { kind: 'status', text: 'The provider had already finished this turn.' }
    ])
  })

  it('propagates an unconfirmed adapter failure and leaves the prompt pending', async () => {
    const { journal, itemId } = await pendingPrompt()
    const flush = vi.fn(async () => undefined)

    await expect(
      performCancel(
        context(
          journal,
          async () => {
            throw new Error('interrupt receipt lost')
          },
          flush
        ),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).rejects.toThrow('interrupt receipt lost')

    expect(flush).not.toHaveBeenCalled()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      expect.objectContaining({ resolution: expect.objectContaining({ state: 'pending' }) })
    ])
  })

  it('surfaces a lifecycle drain failure after the provider confirms interruption', async () => {
    const { journal, itemId } = await pendingPrompt()
    const flush = vi.fn(async () => {
      throw new Error('journal drain failed')
    })

    await expect(
      performCancel(
        context(journal, async () => ({ cancelled: true }), flush),
        {
          clientOperationId: 'cancel-1',
          turnId: 'turn-1',
          prompt: { itemId, expectedRevision: 1 }
        }
      )
    ).rejects.toThrow('journal drain failed')
    expect(journal.snapshot().items).toHaveLength(1)
  })
})

describe("a card's own Cancel, as its provider answers it", () => {
  async function cancelCard(answer: AgentSessionPromptRoute | undefined, revision = 1) {
    const { journal, itemId } = await pendingPrompt([
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' }
    ])
    const ctx = context(
      journal,
      vi.fn(async () => ({ cancelled: true })),
      vi.fn(async () => undefined)
    )
    const answerPrompt = vi.fn<StructuredAgentSessionAdapter['answerPrompt']>(async (input) => {
      await input.commit()
    })
    Object.assign(ctx.adapter, { answerPrompt, routePromptAnswer: () => answer })
    const routes = {
      stop: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
      interrupt: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } }))
    }
    const result = await cancelStructuredAgentSessionPrompt(
      ctx,
      { turnId: 'turn-1', prompt: { itemId, expectedRevision: revision } },
      routes
    )
    const card = journal.snapshot().items.find((item) => item.itemId === itemId)?.body
    return { result, routes, answerPrompt, card }
  }

  it('interrupts the turn holding the card for a provider that gives no answer', async () => {
    const { routes, answerPrompt } = await cancelCard(undefined)

    expect(routes.interrupt).toHaveBeenCalledOnce()
    expect(routes.stop).not.toHaveBeenCalled()
    expect(answerPrompt).not.toHaveBeenCalled()
  })

  it("sends the provider's option as if the user picked it, and reaches no Stop", async () => {
    const { result, routes, answerPrompt, card } = await cancelCard({
      kind: 'option',
      optionId: 'deny'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(answerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ response: { kind: 'option', optionId: 'deny' } })
    )
    expect(card).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'deny', resolvedBy: 'client-1' }
    })
    expect(routes.stop).not.toHaveBeenCalled()
    expect(routes.interrupt).not.toHaveBeenCalled()
  })

  it("runs the chat's Stop for a provider whose card Cancel is a Stop", async () => {
    const { routes, answerPrompt } = await cancelCard({ kind: 'stop' })

    expect(routes.stop).toHaveBeenCalledOnce()
    expect(routes.interrupt).not.toHaveBeenCalled()
    expect(answerPrompt).not.toHaveBeenCalled()
  })

  it('refuses a card that moved on before choosing a route', async () => {
    const { result, routes } = await cancelCard({ kind: 'stop' }, 2)

    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_item_revision_stale' }
    })
    expect(routes.stop).not.toHaveBeenCalled()
  })
})

describe("a card's option its provider routes to the chat's Stop", () => {
  async function pick(optionId: string, revision = 1) {
    const { journal, itemId } = await pendingPrompt([
      { id: 'allow', label: 'Allow' },
      { id: 'cancel', label: 'Stop' }
    ])
    const ctx = context(
      journal,
      vi.fn(async () => ({ cancelled: true })),
      vi.fn(async () => undefined)
    )
    Object.assign(ctx.adapter, {
      routePromptAnswer: (_sessionId: string, _kind: string, picked?: string) =>
        picked === 'cancel' ? { kind: 'stop' } : undefined
    })
    const routes = {
      stop: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
      answer: vi.fn(async () => ({
        ok: true as const,
        value: {
          itemId,
          revision: 2,
          resolution: {
            state: 'resolved' as const,
            selectedOptionId: optionId,
            resolvedBy: 'client-1',
            resolvedAt: 1
          }
        }
      }))
    }
    const result = await answerStructuredAgentSessionPromptOrStop(
      ctx,
      { itemId, expectedRevision: revision, kind: 'approval', optionId },
      routes
    )
    return { result, routes, itemId }
  }

  it("runs the chat's Stop and reports the card as it reads", async () => {
    const { result, routes, itemId } = await pick('cancel')

    expect(routes.stop).toHaveBeenCalledOnce()
    expect(routes.answer).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      value: { itemId, revision: 1, resolution: { state: 'pending' } }
    })
  })

  it('answers any other option as picked', async () => {
    const { routes } = await pick('allow')

    expect(routes.answer).toHaveBeenCalledOnce()
    expect(routes.stop).not.toHaveBeenCalled()
  })

  it('refuses a card that moved on before stopping anything', async () => {
    const { result, routes } = await pick('cancel', 2)

    expect(result).toMatchObject({ ok: false })
    expect(routes.stop).not.toHaveBeenCalled()
  })
})

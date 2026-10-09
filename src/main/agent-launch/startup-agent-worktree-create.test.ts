import { describe, expect, it, vi } from 'vitest'
import type { CreateWorktreeResult } from '../../shared/worktree/create-types'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import { createWorktreeWithStartupAgent } from './startup-agent-worktree-create'

const CHAT_DEFAULT_ON = { experimentalNativeChat: true }

function harness(
  options: {
    created?: Partial<CreateWorktreeResult>
    draftAgent?: string | null
    createError?: Error
  } = {}
) {
  const created = {
    worktree: { id: 'repo-1::/wt/new' },
    startupTerminal: {
      spawned: true,
      handle: 'term_agent',
      paneKey: 'tab-1:leaf-1'
    },
    ...options.created
  }
  const runtime = {
    getClientSettings: () => CHAT_DEFAULT_ON,
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({
      supported: true
    })),
    showRepo: vi.fn(async () => ({ id: 'repo-1', connectionId: null })),
    resolveStartupDraftAgent: vi.fn(async () =>
      options.draftAgent === undefined ? 'claude' : options.draftAgent
    ),
    createManagedWorktree: vi.fn(async (_args: RuntimeManagedWorktreeCreateArgs) => {
      if (options.createError) {
        throw options.createError
      }
      return created
    })
  }
  return {
    runtime,
    created,
    create: (args: RuntimeManagedWorktreeCreateArgs) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method the entry and the executor reach.
      createWorktreeWithStartupAgent(runtime as never, args)
  }
}

const BASE: RuntimeManagedWorktreeCreateArgs = {
  repoSelector: 'repo-1',
  name: 'feature',
  activate: false,
  setupDecision: 'skip',
  lineage: { noParent: true }
}

describe('createWorktreeWithStartupAgent', () => {
  it('starts a terminal agent with the prompt folded by the create, whatever the chat default', async () => {
    const { runtime, created, create } = harness()
    const prompt = 'x'.repeat(3000)

    const result = await create({
      ...BASE,
      startupAgent: 'claude',
      startupPrompt: prompt,
      startupLaunchSource: 'cli'
    })

    expect(result).toBe(created)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
    const args = runtime.createManagedWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      ...BASE,
      startupAgent: 'claude',
      startupPrompt: prompt,
      startupLaunchSource: 'cli'
    })
    // `worktree.create` never measured the typed line, and never awaited setup before replying.
    expect(args).not.toHaveProperty('onStartupPromptCarry')
    expect(args).not.toHaveProperty('awaitTerminalProvisioning')
    expect(args).not.toHaveProperty('observeSetupCompletion')
    expect(args).not.toHaveProperty('startupDraft')
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('hands a post-start agent its prompt through the create, which sends it once the agent is up', async () => {
    const { runtime, create } = harness()

    await create({
      ...BASE,
      startupAgent: 'aider',
      startupPrompt: 'fix the bug'
    })

    expect(runtime.createManagedWorktree.mock.calls[0][0]).toMatchObject({
      startupAgent: 'aider',
      startupPrompt: 'fix the bug'
    })
  })

  it('keeps an empty prompt, which launches the agent bare', async () => {
    const { runtime, create } = harness()

    await create({ ...BASE, startupAgent: 'codex', startupPrompt: '' })

    expect(runtime.createManagedWorktree.mock.calls[0][0]).toMatchObject({
      startupAgent: 'codex',
      startupPrompt: ''
    })
  })

  it('starts a linked draft through `startupDraft`, unsent, with the agent the draft resolves', async () => {
    const { runtime, create } = harness({ draftAgent: 'codex' })

    await create({ ...BASE, startupDraft: 'https://github.com/o/r/issues/1' })

    expect(runtime.resolveStartupDraftAgent).toHaveBeenCalledWith(
      { id: 'repo-1', connectionId: null },
      undefined
    )
    const args = runtime.createManagedWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupDraft: 'https://github.com/o/r/issues/1',
      createdWithAgent: 'codex'
    })
    // A `startupAgent` would override the draft and start the agent with no URL in its composer.
    expect(args).not.toHaveProperty('startupAgent')
    expect(args).not.toHaveProperty('startupPrompt')
  })

  it('asks for the requested draft agent', async () => {
    const { runtime, create } = harness()

    await create({
      ...BASE,
      startupDraft: 'https://x/1',
      createdWithAgent: 'claude'
    })

    expect(runtime.resolveStartupDraftAgent).toHaveBeenCalledWith(expect.anything(), 'claude')
  })

  it('creates without an agent when the draft resolves none, as the create would', async () => {
    const { runtime, create } = harness({ draftAgent: null })
    const args = { ...BASE, startupDraft: 'https://x/1' }

    await create(args)

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(args)
  })

  it('passes a request with no agent, a blank draft, or a prebuilt command straight to the create', async () => {
    for (const args of [
      BASE,
      { ...BASE, startupDraft: '   ' },
      {
        ...BASE,
        startupAgent: 'claude' as const,
        startup: { command: 'claude' }
      }
    ]) {
      const { runtime, create } = harness()
      await create(args)
      expect(runtime.createManagedWorktree).toHaveBeenCalledWith(args)
      expect(runtime.showRepo).not.toHaveBeenCalled()
    }
  })

  it('builds no second agent when the create spawned none here', async () => {
    const { runtime, created, create } = harness({
      created: {
        startupTerminal: undefined,
        warning: 'Failed to create the startup terminal for /wt/new: spawn failed'
      }
    })

    const result = await create({
      ...BASE,
      startupAgent: 'claude',
      startupPrompt: 'hi'
    })

    expect(result).toBe(created)
    expect(runtime.createManagedWorktree).toHaveBeenCalledTimes(1)
  })

  it('surfaces a create failure unchanged', async () => {
    const failure = new Error(
      'Selected agent is disabled. Choose an enabled agent before creating.'
    )
    const { create } = harness({ createError: failure })

    await expect(create({ ...BASE, startupAgent: 'claude' })).rejects.toBe(failure)
  })
})

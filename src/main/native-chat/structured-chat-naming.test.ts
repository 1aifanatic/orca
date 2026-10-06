import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import { setAgentSessionRecordConversationName } from '../runtime/agent-session-record-conversation-name'
import {
  createStructuredChatNamingHandler,
  type StructuredChatNamingDeps
} from './structured-chat-naming'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred not initialized')
  }
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function settle() {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve()
  }
}

function rig(provider: 'claude' | 'codex') {
  let record: AgentSessionRecord | null = { ...agentSessionRecordFixture(), provider }
  const getRecord = vi.fn(() => record)
  const setConversationName = vi.fn(
    async (_id: string, name: string | null, expected: string | null) => {
      if (!record) {
        throw new Error('Missing record')
      }
      if ((record.conversationName ?? null) !== expected) {
        return null
      }
      record = setAgentSessionRecordConversationName(record, name, Date.now())
      return record
    }
  )
  const deps: StructuredChatNamingDeps = {
    getStore: () => ({ getRecord, compareAndSetConversationName: setConversationName }),
    getSettings: () => ({}),
    hasOpenDispatch: vi.fn(() => false),
    readFirstPrompt: vi.fn(async () => 'Please repair the login flow'),
    generate: vi.fn(async () => 'auth/login'),
    onNamed: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() }
  }
  const summary: AgentSessionStatusSummary = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    agent: provider,
    status: 'working',
    latestPrompt: 'login preview',
    updatedAt: 100
  }
  return {
    deps,
    summary,
    getRecord,
    setConversationName,
    handle: createStructuredChatNamingHandler(deps),
    read: () => record,
    replace: (next: AgentSessionRecord | null) => {
      record = next
    }
  }
}

describe.each(['claude', 'codex'] as const)('structured %s chat naming', (provider) => {
  it('publishes a first-message title before generation and a name after it', async () => {
    const state = rig(provider)
    const generation = deferred<string | null>()
    state.deps.generate = vi.fn(() => generation.promise)
    expect(state.handle(state.summary, { replay: false })).toBeUndefined()
    await settle()
    expect(state.read()?.conversationName).toBe('Repair the login flow')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(1)
    generation.resolve('auth/login')
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(2)
  })

  it.each([null, 'idle', 'attention'] as const)('does no work for status %s', async (status) => {
    const state = rig(provider)
    state.handle({ ...state.summary, status }, { replay: false })
    await settle()
    expect(state.getRecord).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('does no work on replay', async () => {
    const state = rig(provider)
    state.handle(state.summary, { replay: true })
    await settle()
    expect(state.getRecord).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('skips missing, already named, and worker records before reading the journal', async () => {
    const state = rig(provider)
    const record = state.read()
    if (!record) {
      throw new Error('Missing fixture')
    }
    state.replace(null)
    state.handle(state.summary, { replay: false })
    await settle()
    state.replace({ ...record, conversationName: 'Existing name' })
    state.handle(state.summary, { replay: false })
    await settle()
    state.replace(record)
    state.deps.hasOpenDispatch = () => true
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.deps.readFirstPrompt).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('keeps the first-message title when naming is off', async () => {
    const state = rig(provider)
    state.deps.getSettings = () => ({ nativeChatAutoName: false })
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('Repair the login flow')
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it.each(['rejected', 'declined', 'empty'] as const)(
    'settles %s generation without retrying',
    async (outcome) => {
      const state = rig(provider)
      state.deps.generate = vi.fn(async () => {
        if (outcome === 'rejected') {
          throw new Error('Agent failed')
        }
        return outcome === 'empty' ? '' : null
      })
      state.handle(state.summary, { replay: false })
      await settle()
      state.handle(state.summary, { replay: false })
      await settle()
      expect(state.read()?.conversationName).toBe('Repair the login flow')
      expect(state.deps.generate).toHaveBeenCalledTimes(1)
      const restarted = createStructuredChatNamingHandler(state.deps)
      restarted(state.summary, { replay: false })
      await settle()
      expect(state.deps.generate).toHaveBeenCalledTimes(1)
    }
  )

  it('protects a name changed while generation runs', async () => {
    const state = rig(provider)
    const generation = deferred<string | null>()
    state.deps.generate = vi.fn(() => generation.promise)
    state.handle(state.summary, { replay: false })
    await settle()
    const current = state.read()
    if (!current) {
      throw new Error('Missing fixture')
    }
    state.replace({ ...current, conversationName: 'User name' })
    generation.resolve('Late agent name')
    await settle()
    expect(state.read()?.conversationName).toBe('User name')
    expect(state.deps.onNamed).toHaveBeenCalledTimes(1)
  })

  it('protects a name changed while the first prompt is read', async () => {
    const state = rig(provider)
    const prompt = deferred<string>()
    state.deps.readFirstPrompt = () => prompt.promise
    state.handle(state.summary, { replay: false })
    const current = state.read()
    if (!current) {
      throw new Error('Missing fixture')
    }
    state.replace({ ...current, conversationName: 'User name' })
    prompt.resolve('Please repair the login flow')
    await settle()
    expect(state.read()?.conversationName).toBe('User name')
    expect(state.deps.generate).not.toHaveBeenCalled()
  })

  it('coalesces concurrent edges before the first journal read completes', async () => {
    const state = rig(provider)
    const prompt = deferred<string>()
    state.deps.readFirstPrompt = vi.fn(() => prompt.promise)
    state.handle(state.summary, { replay: false })
    state.handle(state.summary, { replay: false })
    expect(state.deps.readFirstPrompt).toHaveBeenCalledTimes(1)
    prompt.resolve('Repair the login flow')
    await settle()
    expect(state.deps.generate).toHaveBeenCalledTimes(1)
  })

  it('allows only one handler to claim an identical first-message title', async () => {
    const state = rig(provider)
    const prompt = deferred<string>()
    state.deps.readFirstPrompt = () => prompt.promise
    const other = createStructuredChatNamingHandler(state.deps)
    state.handle(state.summary, { replay: false })
    other(state.summary, { replay: false })
    prompt.resolve('Repair the login flow')
    await settle()
    expect(state.deps.generate).toHaveBeenCalledTimes(1)
    expect(state.read()?.conversationName).toBe('auth/login')
  })

  it('waits for text without spawning for an empty or punctuation-only prompt', async () => {
    const state = rig(provider)
    state.deps.readFirstPrompt = async () => '?!'
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.setConversationName).not.toHaveBeenCalled()
    expect(state.deps.generate).not.toHaveBeenCalled()
    state.deps.readFirstPrompt = async () => 'Repair the login flow'
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
  })

  it('falls back to the published prompt if the journal cannot be read', async () => {
    const state = rig(provider)
    state.deps.readFirstPrompt = async () => {
      throw new Error('Unavailable')
    }
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.deps.generate).toHaveBeenCalledWith(expect.anything(), 'login preview')
  })

  it('continues generation when snapshot refresh fails', async () => {
    const state = rig(provider)
    state.deps.onNamed = () => {
      throw new Error('Publish failed')
    }
    state.handle(state.summary, { replay: false })
    await settle()
    expect(state.read()?.conversationName).toBe('auth/login')
    expect(state.deps.logger.warn).toHaveBeenCalled()
  })

  it('contains synchronous dependency and reporting failures off the send path', async () => {
    const state = rig(provider)
    state.deps.getStore = () => {
      throw new Error('Store failed')
    }
    state.deps.logger.warn = () => {
      throw new Error('Logger failed')
    }
    const print = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => state.handle(state.summary, { replay: false })).not.toThrow()
    await settle()
    expect(state.deps.generate).not.toHaveBeenCalled()
    print.mockRestore()
  })
})

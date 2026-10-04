import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import { NO_AGENT_SESSION_CAPABILITIES } from '../../../shared/agent-session-capabilities'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { CLAUDE_STRUCTURED_AGENT } from '../../claude/claude-structured-agent-definition'
import { CODEX_STRUCTURED_AGENT } from '../../codex/codex-structured-agent-definition'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from './structured-agent-session-adapter-router'
import type { StructuredAgentDefinition } from './structured-agent-definition'

const LOCAL: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

function identity(sessionId: string, agent: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent,
    providerHandle: claudeProviderHandle('provider-session-1', null)
  }
}

function acquisition(fence: number, spawnToken: string): AgentSessionAcquisition {
  return {
    process: { hostId: 'local', pid: 1, processStartTimeMs: 1, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: claudeProviderHandle('provider-session-1', null),
      origin: 'created',
      mintedAtFence: fence,
      observedAt: 1
    }
  }
}

function fakeAdapter(
  overrides: Partial<StructuredAgentSessionAdapter> = {}
): StructuredAgentSessionAdapter {
  return {
    supportsLocation: () => true,
    acquire: vi.fn(async ({ fence, spawnToken }) => acquisition(fence, spawnToken)),
    dispatch: vi.fn(),
    cancelTurn: vi.fn(),
    answerPrompt: vi.fn(),
    setOption: vi.fn(),
    ...overrides
  }
}

/** An agent this build does not ship, declared the way a new adapter would declare itself. */
const PILOT: StructuredAgentDefinition = {
  agent: 'grok',
  handleTransport: 'acp',
  accountHomeVariable: 'GROK_HOME',
  capabilities: {
    ...NO_AGENT_SESSION_CAPABILITIES,
    steering: 'queue',
    approvalEnforcement: 'orca'
  },
  restingOptions: {
    acceptsKey: () => false,
    fallbackModels: () => null,
    effortDefaultsToModel: false
  }
}

describe('StructuredAgentSessionAdapterRouter registry', () => {
  it('routes a registered agent the router has no code for, and refuses an unregistered one', async () => {
    const pilot = fakeAdapter()
    const router = new StructuredAgentSessionAdapterRouter(
      [{ definition: PILOT, adapter: pilot }],
      async () => {}
    )

    expect(router.supportsCreate(LOCAL, 'grok')).toBe(true)
    expect(router.supportsCreate(LOCAL, 'claude')).toBe(false)
    await router.acquire({ identity: identity('session-1', 'grok'), fence: 1, spawnToken: 's-1' })
    expect(pilot.acquire).toHaveBeenCalledOnce()
    await expect(
      router.acquire({ identity: identity('session-2', 'claude'), fence: 1, spawnToken: 's-2' })
    ).rejects.toThrow('structured sessions do not support claude')
  })

  it('refuses two registrations for one agent', () => {
    expect(
      () =>
        new StructuredAgentSessionAdapterRouter(
          [
            { definition: PILOT, adapter: fakeAdapter() },
            { definition: PILOT, adapter: fakeAdapter() }
          ],
          async () => {}
        )
    ).toThrow('structured agent grok is registered twice')
  })

  it('answers capabilities from the live owner, else from the agent named at rest', async () => {
    const router = new StructuredAgentSessionAdapterRouter(
      [
        { definition: CLAUDE_STRUCTURED_AGENT, adapter: fakeAdapter() },
        { definition: CODEX_STRUCTURED_AGENT, adapter: fakeAdapter() }
      ],
      async () => {}
    )

    expect(router.capabilities('session-1')).toBeUndefined()
    expect(router.capabilities('session-1', 'codex')).toBe(CODEX_STRUCTURED_AGENT.capabilities)
    expect(router.capabilities('session-1', 'grok')).toBeUndefined()
    await router.acquire({ identity: identity('session-1', 'claude'), fence: 1, spawnToken: 's' })
    // A live session answers for its own agent, whatever a caller names.
    expect(router.capabilities('session-1', 'codex')).toBe(CLAUDE_STRUCTURED_AGENT.capabilities)
  })

  it('lets a session narrow a declared rewind but never widen an undeclared one', () => {
    const narrowing = fakeAdapter({
      rewindSupport: () => ({ supported: false, reason: 'history-not-paginated' })
    })
    const widening = fakeAdapter({ rewindSupport: () => ({ supported: true }) })
    const router = new StructuredAgentSessionAdapterRouter(
      [
        { definition: CODEX_STRUCTURED_AGENT, adapter: narrowing },
        { definition: CLAUDE_STRUCTURED_AGENT, adapter: widening }
      ],
      async () => {}
    )

    expect(router.rewindSupport('session-1', 'codex')).toEqual({
      supported: false,
      reason: 'history-not-paginated'
    })
    expect(router.rewindSupport('session-1', 'claude')).toEqual({
      supported: false,
      reason: 'unsupported'
    })
  })
})

describe('structured agent definitions', () => {
  it('declares what Claude and Codex structured chats already did', () => {
    expect(CLAUDE_STRUCTURED_AGENT.capabilities).toEqual({
      rewind: false,
      compact: true,
      threadGoal: false,
      contextUsage: true,
      imagePrompts: true,
      steering: 'inject',
      approvalEnforcement: 'provider'
    })
    expect(CODEX_STRUCTURED_AGENT.capabilities).toEqual({
      rewind: true,
      compact: true,
      threadGoal: true,
      contextUsage: false,
      imagePrompts: true,
      steering: 'inject',
      approvalEnforcement: 'provider'
    })
  })

  it('keeps each agent’s resting option rules with its definition', () => {
    const claude = CLAUDE_STRUCTURED_AGENT.restingOptions
    const codex = CODEX_STRUCTURED_AGENT.restingOptions
    expect(claude.fallbackModels()?.length).toBeGreaterThan(0)
    expect(codex.fallbackModels()).toBeNull()
    expect(claude.effortDefaultsToModel).toBe(true)
    expect(codex.effortDefaultsToModel).toBe(false)
    expect(claude.acceptsKey('model')).toBe(true)
    expect(codex.acceptsKey('model')).toBe(true)
    expect(claude.acceptsKey('no-such-option')).toBe(false)
  })
})

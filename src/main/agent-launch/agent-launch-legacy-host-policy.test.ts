import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import { decideAgentLaunchMode } from './agent-launch-mode'
import { AgentLaunchStartupAgentNotCreatedError } from './agent-launch-surface-factories'

const getStructuredAgentSessionCreateSupport = vi.fn(async () => ({ supported: true }))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the two runtime methods the executor reaches; the chat default is on so a terminal-only launch is proven to ignore it.
const runtime = {
  getClientSettings: () => ({ experimentalNativeChat: true }),
  getStructuredAgentSessionCreateSupport
} as unknown as AgentLaunchExecution['runtime']

function workspaces(startupTerminalHandle: string | undefined) {
  return {
    createWorktree: vi.fn(async (_args: Record<string, unknown>) => ({
      worktreeId: 'wt-new',
      connectionId: null,
      startupTerminalHandle
    }))
  }
}

describe('terminal-only launches', () => {
  it('settle as a terminal whatever the chat default says', () => {
    expect(
      decideAgentLaunchMode({
        placement: { agent: 'claude', workspaceKind: 'git-worktree' },
        settings: { experimentalNativeChat: true },
        terminalOnly: true
      })
    ).toMatchObject({
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default'
    })
  })
})

describe('the legacy-host prompt policy', () => {
  it('hands the whole text to the create and delivers nothing itself', async () => {
    const factory = workspaces('term_agent')

    const result = await executeAgentLaunch({
      runtime,
      intent: {
        agent: 'aider',
        target: { kind: 'create-worktree', create: { repo: 'repo-1' } },
        prompt: { text: 'fix the bug', delivery: 'submit' }
      },
      terminalOnly: true,
      promptPolicy: 'legacy-host',
      workspaces: factory
    })

    const args = factory.createWorktree.mock.calls[0][0]
    expect(args).toMatchObject({
      startupAgent: 'aider',
      legacyPrompt: { text: 'fix the bug', delivery: 'submit' }
    })
    expect(args).not.toHaveProperty('startupPrompt')
    expect(result).toMatchObject({
      outcome: { kind: 'terminal', handle: 'term_agent' },
      prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
    })
    expect(getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('reports a draft as never delivered by the host', async () => {
    const result = await executeAgentLaunch({
      runtime,
      intent: {
        agent: 'codex',
        target: { kind: 'create-worktree', create: { repo: 'repo-1' } },
        prompt: { text: 'https://x/1', delivery: 'draft' }
      },
      terminalOnly: true,
      promptPolicy: 'legacy-host',
      workspaces: workspaces('term_agent')
    })

    expect(result.prompt).toEqual({
      delivery: 'draft',
      outcome: 'not-delivered'
    })
  })

  it('builds no second surface when the create started no agent', async () => {
    await expect(
      executeAgentLaunch({
        runtime,
        intent: {
          agent: 'claude',
          target: { kind: 'create-worktree', create: { repo: 'r' } }
        },
        terminalOnly: true,
        promptPolicy: 'legacy-host',
        workspaces: workspaces(undefined)
      })
    ).rejects.toBeInstanceOf(AgentLaunchStartupAgentNotCreatedError)
  })

  it('applies only to a terminal-only create', async () => {
    const intent = {
      agent: 'claude' as const,
      target: { kind: 'existing' as const, worktree: 'w' }
    }
    await expect(
      executeAgentLaunch({
        runtime,
        intent,
        terminalOnly: true,
        promptPolicy: 'legacy-host'
      })
    ).rejects.toThrow('agent_launch_legacy_prompt_policy_requires_terminal_create')
    await expect(
      executeAgentLaunch({
        runtime,
        intent: {
          agent: 'claude',
          target: { kind: 'create-worktree', create: {} }
        },
        promptPolicy: 'legacy-host',
        workspaces: workspaces('term_agent')
      })
    ).rejects.toThrow('agent_launch_legacy_prompt_policy_requires_terminal_create')
  })
})

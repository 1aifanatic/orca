import { expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import { withAgentChatPermissionSeed } from '../native-chat/agent-chat-permission-mode-setting'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import { fakeClaude } from './claude-structured-session-test-support'

it.each(['accept-edits', 'auto'] as const)(
  'retains creation %s across Stop before initialize and a changed new-chat default',
  async (initialMode) => {
    let defaultMode: AgentChatPermissionMode = initialMode
    const saved = {
      ...record({ chain: [] }),
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' },
      options: withAgentChatPermissionSeed(
        'claude',
        { nativeChatPermissionMode: defaultMode },
        { model: 'sonnet' }
      )
    }
    expect(saved.options).toEqual({ model: 'sonnet', permissionMode: initialMode })
    const identity = {
      sessionId: saved.sessionId,
      workspaceId: saved.location.workspaceId,
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    }
    const resolveLaunch = createClaudeStructuredLaunchResolver({
      store: { getRecord: () => saved, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => process.cwd(),
      resolveAuthPolicy: () => ({ stripAuthEnv: false }),
      resolveCommand: () => 'claude',
      resolveLaunchArgs: () => [],
      resolveDefaultPermissionMode: () => defaultMode
    })
    const claude = fakeClaude({ initProof: 'none' })
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch,
      openConnection: async (...args) => {
        const connection = await claude.openConnection(...args)
        connection.initializationResult = () => new Promise(() => {})
        return connection
      }
    })
    const acquire = { identity, fence: 1, spawnToken: 'first', options: saved.options }
    try {
      await adapter.acquire(acquire)
      const preparation = adapter.prepareDispatch(saved.sessionId)
      const aborted = Promise.resolve(preparation).catch(() => {})
      await adapter.closeSession(saved.sessionId)
      await aborted
      expect(claude.connections[0].closeCount).toBeGreaterThan(0)
      expect(claude.connections[0].sent).toEqual([])
      defaultMode = 'bypass'
      await adapter.acquire({ ...acquire, fence: 2, spawnToken: 'next' })
      const launch = claude.connections[1].launch
      expect(launch.options.extraArgs).not.toHaveProperty('dangerously-skip-permissions')
      expect(launch.options.permissionMode).toBe('default')
      expect(adapter['sessions'].get(saved.sessionId)?.options.get('permissionMode')).toBe(
        initialMode
      )
      expect(saved.options?.permissionMode).toBe(initialMode)
    } finally {
      await adapter.closeAll()
    }
  }
)

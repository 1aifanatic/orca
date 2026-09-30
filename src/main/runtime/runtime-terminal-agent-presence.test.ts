import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'

describe('headless terminal presence', () => {
  it.each([false, true])('uses host presence under a shell title (ended=%s)', async (ended) => {
    const presence: AgentProcessPresence = {
      agent: 'claude',
      process: { pid: 42, platform: 'linux', startTime: 'boot:42' },
      ...(ended ? { ended: true } : {})
    }
    const query = new RuntimeTerminalAgentStatusQuery({
      getAgentPresence: () => presence,
      getController: () => null,
      getLivePty: () => null,
      getLiveLeaf: () => {
        throw new Error('unexpected leaf lookup')
      },
      getPrimaryLeaf: () => null,
      getTabTitle: () => 'zsh',
      getExplicitStatus: () => null,
      getLifecycleStatus: () => null,
      isRunning: async () => false
    })
    vi.spyOn(query, 'getPtyId').mockReturnValue('pty-1')
    vi.spyOn(query, 'getSnapshot').mockReturnValue({
      waitText: '',
      waitBlockedAt: null,
      title: 'zsh',
      titleStatus: null,
      titleStatusIsLive: false
    })
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: !ended,
      status: null
    })
  })
})

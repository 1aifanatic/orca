import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

function statusQuery(title: string, confirmForegroundProcess: () => Promise<string | null>) {
  const controller: RuntimePtyController = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'zsh',
    confirmForegroundProcess
  }
  const query = new RuntimeTerminalAgentStatusQuery({
    getController: () => controller,
    getLivePty: () => null,
    getLiveLeaf: () => {
      throw new Error('unused')
    },
    getPrimaryLeaf: () => null,
    getTabTitle: () => null,
    getExplicitStatus: () => ({ status: 'idle', updatedAt: Date.now() }),
    getLifecycleStatus: () => null,
    isRunning: async () => true
  })
  vi.spyOn(query, 'getPtyId').mockReturnValue('pty-1')
  vi.spyOn(query, 'getSnapshot').mockReturnValue({
    waitText: '',
    waitBlockedAt: null,
    title,
    titleStatus: null,
    titleStatusIsLive: true
  })
  return query
}

describe('Claude management title', () => {
  it('reports no running agent under the claude agents screen despite a fresh hook', async () => {
    const query = statusQuery('claude agents', async () => 'claude')
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: false,
      status: null
    })
  })
})

describe('status survives an unconfirmed shell observation', () => {
  it.each([null, '', 'node.exe', 'claude', 'zsh', 'throw'])(
    'confirms the foreground before retiring status: %j',
    async (result) => {
      const controller: RuntimePtyController = {
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        confirmForegroundProcess: async () => {
          if (result === 'throw') {
            throw new Error('offline')
          }
          return result
        }
      }
      const query = new RuntimeTerminalAgentStatusQuery({
        getController: () => controller,
        getLivePty: () => null,
        getLiveLeaf: () => {
          throw new Error('unused')
        },
        getPrimaryLeaf: () => null,
        getTabTitle: () => null,
        getExplicitStatus: () => ({ status: 'idle', updatedAt: Date.now() }),
        getLifecycleStatus: () => null,
        isRunning: async () => true
      })
      vi.spyOn(query, 'getPtyId').mockReturnValue('pty-1')
      vi.spyOn(query, 'getSnapshot').mockReturnValue({
        waitText: '',
        waitBlockedAt: null,
        title: 'zsh',
        titleStatus: null,
        titleStatusIsLive: true
      })
      expect(await query.getStatus('terminal')).toEqual({
        handle: 'terminal',
        isRunningAgent: result !== 'zsh',
        status: result === 'zsh' ? null : 'idle'
      })
    }
  )
})

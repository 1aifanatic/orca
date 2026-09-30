import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import { RuntimeTerminalAgentPresence } from './runtime-terminal-agent-presence'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'

const CURSOR_APPROVAL = readFileSync(
  join(__dirname, '__fixtures__', 'cursor-agent-approval-prompt.txt'),
  'utf8'
)

function owner(agent: string, ended = false): AgentProcessPresence {
  return {
    agent,
    process: { pid: 42, platform: 'linux', startTime: 'boot:42' },
    ...(ended ? { ended: true as const } : {})
  }
}

function leaf(title: string): RuntimeLeafRecord {
  return {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    leafId: 'leaf-1',
    paneRuntimeId: 1,
    ptyId: 'pty-1',
    paneTitle: title,
    ptyGeneration: 1,
    connected: true,
    writable: true,
    lastOutputAt: null,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastAgentStatusObservedLive: false,
    lastOscTitle: title,
    lastOscTitleAt: 1,
    paneTitleUpdatedAt: 1,
    tailBuffer: [],
    tailTranscriptBuffer: [],
    tailTranscriptChars: 0,
    tailPartialLine: '',
    tailPendingAnsi: '',
    tailRedrawCursor: null,
    tailTruncated: false,
    tailLinesTotal: 0,
    preview: '',
    waitBlockedAt: null
  }
}

function terminal(args: {
  presence: AgentProcessPresence | undefined
  title: string
  foreground: string
  waitText?: string
  explicit?: 'working' | 'done'
}) {
  const presence = new RuntimeTerminalAgentPresence({
    getAgentPresence: () => args.presence,
    getLivePty: () => null,
    getLiveLeaf: () => leaf(args.title),
    getPrimaryLeaf: () => null,
    getTrackedPty: () => null,
    getTabTitle: () => null,
    getForegroundProcess: async () => args.foreground
  })
  const query = new RuntimeTerminalAgentStatusQuery({
    getAgentPresence: () => args.presence,
    getController: () => null,
    getLivePty: () => null,
    getLiveLeaf: () => ({ leaf: leaf(args.title) }),
    getPrimaryLeaf: () => null,
    getTabTitle: () => args.title,
    getExplicitStatus: () =>
      args.explicit ? { status: args.explicit, updatedAt: Date.now() - 1000 } : null,
    getLifecycleStatus: () => null,
    isRunning: (handle) => presence.isRunning(handle)
  })
  vi.spyOn(query, 'getPtyId').mockReturnValue('pty-1')
  vi.spyOn(query, 'getSnapshot').mockReturnValue({
    waitText: args.waitText ?? '',
    waitBlockedAt: args.waitText ? Date.now() : null,
    title: args.title,
    titleStatus: null,
    titleStatusIsLive: true
  })
  return { presence, query }
}

describe('headless terminal presence', () => {
  it.each([false, true])('uses host presence under a shell title (ended=%s)', async (ended) => {
    const { query } = terminal({
      presence: owner('claude', ended),
      title: 'zsh',
      foreground: 'zsh'
    })
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: !ended,
      status: null
    })
  })

  it('keeps the approval-menu permission ahead of an identified owner', async () => {
    // Cursor reports its approval gate as working; only the screen shows the menu.
    const { query } = terminal({
      presence: owner('cursor'),
      title: 'Cursor Agent',
      foreground: 'cursor-agent',
      waitText: CURSOR_APPROVAL,
      explicit: 'working'
    })
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: true,
      status: 'permission'
    })
  })

  it('keeps the management screen from reading as a task agent for an identified owner', async () => {
    const { presence, query } = terminal({
      presence: owner('claude'),
      title: 'claude agents',
      foreground: 'claude',
      explicit: 'working'
    })
    expect(await presence.isRunning('terminal')).toBe(false)
    expect(await query.getStatus('terminal')).toEqual({
      handle: 'terminal',
      isRunningAgent: false,
      status: null
    })
  })
})

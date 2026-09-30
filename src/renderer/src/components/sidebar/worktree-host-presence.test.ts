import { collectTabPaneInputs, resolveAttention } from './smart-attention'
import { describe, expect, it } from 'vitest'
import { makeTab } from '@/store/slices/store-test-helpers'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { getWorktreeStatus } from '@/lib/worktree-status'

const leafId = '11111111-1111-4111-8111-111111111111'
const paneKey = `tab-1:${leafId}`
const tab = makeTab({
  id: 'tab-1',
  worktreeId: 'folder-1',
  title: '✳ Claude Code',
  launchAgent: 'claude'
})
const agentPresenceByPaneKey = {
  [paneKey]: {
    presence: {
      agent: 'claude',
      process: { pid: 4001, platform: 'linux', startTime: 'boot:123' },
      ended: true
    },
    receivedAt: 20
  }
} as const
const entry = {
  paneKey,
  agentType: 'claude',
  state: 'working',
  prompt: 'work',
  updatedAt: Date.now(),
  stateStartedAt: Date.now(),
  stateHistory: []
} as const
const terminalLayoutsByTabId = {
  'tab-1': { root: { type: 'leaf', leafId }, activeLeafId: leafId, expandedLeafId: null }
} as const

describe('workspace host exit publication', () => {
  it('clears a live sidebar row immediately and suppresses its stale title without a shell prompt', () => {
    expect(
      buildWorktreeAgentRows({
        tabs: [tab],
        entries: [{ ...entry, stateHistory: [] }],
        retained: [],
        agentPresenceByPaneKey,
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        terminalLayoutsByTabId,
        now: Date.now()
      })
    ).toEqual([])
  })
  it('stops the workspace activity signal even when the PTY and spinner title remain', () => {
    const summary = selectWorktreeAgentActivitySummary(
      {
        tabsByWorktree: { 'folder-1': [tab] },
        agentStatusByPaneKey: { [paneKey]: { ...entry, stateHistory: [] } },
        agentPresenceByPaneKey,
        agentStatusEpoch: 1,
        retainedAgentsByPaneKey: {},
        migrationUnsupportedByPtyId: {}
      },
      'folder-1'
    )
    expect(summary.hasLiveWorking).toBe(false)
    expect(
      getWorktreeStatus(
        [tab],
        [],
        { 'tab-1': ['pty-1'] },
        {},
        {
          agentStatusPaneIdsByTabId: summary.agentStatusPaneIdsByTabId,
          terminalLayoutsByTabId
        }
      )
    ).toBe('active')
  })
  it('removes ended owners from smart attention despite a stale spinner title', () => {
    const inputs = collectTabPaneInputs(
      tab,
      Date.now(),
      {
        entriesByTabId: new Map([[tab.id, [{ ...entry, stateHistory: [] }]]]),
        agentPresenceByPaneKey,
        ptyIdsByTabId: { [tab.id]: ['pty-1'] },
        runtimePaneTitlesByTabId: {},
        terminalLayoutsByTabId
      },
      Date.now()
    )
    expect(resolveAttention(inputs, Date.now()).cls).toBe(5)
  })
})

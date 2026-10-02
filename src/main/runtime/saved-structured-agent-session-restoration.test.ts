import { describe, expect, it } from 'vitest'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { orderOnScreenStructuredAgentSessionsFirst } from '../../shared/saved-on-screen-structured-agent-sessions'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import { runStructuredAgentSessionStartupStep } from './structured-agent-session-startup-step'

function tab(input: Partial<Tab> & Pick<Tab, 'id'>): Tab {
  const { id, ...overrides } = input
  return {
    id,
    entityId: input.entityId ?? id,
    groupId: 'group-1',
    worktreeId: 'workspace-1',
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function session(tabs: Tab[], activeTabId: string | null): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: 'workspace-1',
    activeTabId,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: { 'workspace-1': tabs },
    activeTabIdByWorktree: { 'workspace-1': activeTabId }
  }
}

describe('saved structured session restoration targets', () => {
  it('prioritizes the visible chat and excludes closed history', () => {
    const saved = session(
      [
        tab({ id: 'tab-background', entityId: 'session-background' }),
        tab({ id: 'tab-visible', entityId: 'session-visible' })
      ],
      'tab-visible'
    )

    expect(collectSavedStructuredAgentSessionIds(saved)).toEqual([
      'session-visible',
      'session-background'
    ])
    expect(collectSavedStructuredAgentSessionIds(session([], null))).toEqual([])
  })

  it('keeps restoration on the local execution host and deduplicates repeated sessions', () => {
    const saved = session(
      [
        tab({ id: 'remote', executionHostId: 'ssh:build', entityId: 'session-remote' }),
        tab({ id: 'local-a', entityId: 'session-local' }),
        tab({ id: 'local-b', entityId: 'session-local' }),
        tab({ id: 'terminal', contentType: 'terminal', entityId: 'pty-tab-1' })
      ],
      'remote'
    )

    expect(collectSavedStructuredAgentSessionIds(saved)).toEqual(['session-local'])
  })

  it('skips explicitly Claude-owned structured tabs', () => {
    const saved = session(
      [
        tab({
          id: 'claude-tab',
          agentSessionAgent: 'claude',
          entityId: 'session-claude'
        }),
        tab({
          id: 'codex-tab',
          agentSessionAgent: 'codex',
          entityId: 'session-codex'
        })
      ],
      'claude-tab'
    )

    expect(collectSavedStructuredAgentSessionIds(saved)).toEqual(['session-codex'])
  })

  it("fills the chats on screen first: the active worktree's visible tabs, then every other worktree's", async () => {
    const tabs = {
      'workspace-1': [
        tab({ id: 'a-1', entityId: 'session-a-1' }),
        tab({ id: 'a-2', entityId: 'session-a-2' })
      ],
      'workspace-2': [
        tab({ id: 'b-1', worktreeId: 'workspace-2', entityId: 'session-b-1' }),
        tab({
          id: 'b-2',
          worktreeId: 'workspace-2',
          entityId: 'session-b-2',
          agentSessionAgent: 'claude'
        }),
        tab({
          id: 'b-remote',
          worktreeId: 'workspace-2',
          entityId: 'session-b-remote',
          executionHostId: 'ssh:build'
        })
      ]
    }
    const group = (id: string, worktreeId: string, activeTabId: string) => ({
      id,
      worktreeId,
      activeTabId,
      tabOrder: [activeTabId]
    })
    // As the renderer saves it: each group's active tab is what is on screen, the focused group's
    // first; `activeTabIdByWorktree` names a terminal whatever is shown.
    const saved: WorkspaceSessionState = {
      ...session([], null),
      activeWorktreeId: 'workspace-2',
      unifiedTabs: tabs,
      tabGroups: {
        'workspace-1': [group('g-a', 'workspace-1', 'a-2')],
        'workspace-2': [
          group('g-b-left', 'workspace-2', 'b-1'),
          group('g-b-right', 'workspace-2', 'b-2')
        ]
      },
      activeGroupIdByWorktree: { 'workspace-1': 'g-a', 'workspace-2': 'g-b-right' },
      activeTabIdByWorktree: { 'workspace-1': 'terminal-a', 'workspace-2': 'terminal-b' }
    }
    // The pass's order: the host's tab order, which knows nothing of what is on screen.
    const listed = ['session-a-1', 'session-a-2', 'session-b-1', 'session-b-2', 'session-b-remote']

    expect(orderOnScreenStructuredAgentSessionsFirst(listed, saved)).toEqual([
      'session-b-2',
      'session-b-1',
      'session-a-2',
      'session-a-1',
      'session-b-remote'
    ])
    // Only reorders the chats it is given.
    expect(orderOnScreenStructuredAgentSessionsFirst(['session-a-1'], saved)).toEqual([
      'session-a-1'
    ])
    expect(orderOnScreenStructuredAgentSessionsFirst(listed, null)).toEqual(listed)

    const host = {
      reconcileRestartLeases: async () => undefined,
      getPersistedVisibleSessionTabIndex: () => ({ present: true, sessionIds: listed }),
      seedStoredStatuses: (ids: readonly string[]) => [...ids],
      settleOwedSessions: async () => undefined
    }
    expect(await runStructuredAgentSessionStartupStep(host, saved, () => undefined)).toEqual([
      'session-b-2',
      'session-b-1',
      'session-a-2',
      'session-a-1',
      'session-b-remote'
    ])
  })
})

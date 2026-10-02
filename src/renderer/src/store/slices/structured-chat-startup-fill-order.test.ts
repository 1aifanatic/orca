// The startup status pass fills the chats on screen first, read from the workspace session the
// renderer really saves: a chat the user is looking at is its tab group's active tab, while
// `activeTabIdByWorktree` keeps naming a terminal.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import type { Tab } from '../../../../shared/tab-types'
import { orderOnScreenStructuredAgentSessionsFirst } from '../../../../main/runtime/saved-structured-agent-session-restoration'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'
import { buildActiveSurfacePatch } from './tabs/tabs-surface'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
createTabsSliceMockApi()

const WORKTREE = 'repo1::/tmp/feature'
const GROUP = 'group-1'

function tab(id: string, contentType: Tab['contentType'], sortOrder: number): Tab {
  return {
    id,
    entityId: contentType === 'agent-session' ? `session-${id.slice(-1)}` : id,
    groupId: GROUP,
    worktreeId: WORKTREE,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder,
    ...(contentType === 'agent-session' ? { agentSessionAgent: 'codex' as const } : {})
  }
}

describe('the chats on screen at launch', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    const tabs = [
      tab('terminal-1', 'terminal', 0),
      tab('structured-session-1', 'agent-session', 1),
      tab('structured-session-2', 'agent-session', 2),
      tab('structured-session-3', 'agent-session', 3)
    ]
    store.setState({
      activeWorktreeId: WORKTREE,
      unifiedTabsByWorktree: { [WORKTREE]: tabs },
      groupsByWorktree: {
        [WORKTREE]: [
          {
            id: GROUP,
            worktreeId: WORKTREE,
            activeTabId: 'terminal-1',
            tabOrder: tabs.map(({ id }) => id)
          }
        ]
      },
      activeGroupIdByWorktree: { [WORKTREE]: GROUP },
      tabsByWorktree: {
        [WORKTREE]: [
          {
            id: 'terminal-1',
            ptyId: 'pty-1',
            worktreeId: WORKTREE,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      ptyIdsByTabId: { 'terminal-1': ['pty-1'] },
      activeTabIdByWorktree: { [WORKTREE]: 'terminal-1' }
    })
  })

  it('come first in the pass, as the saved session records the chat the user is looking at', () => {
    // The user looks at the third chat; then the worktree's surface is applied, as a focus does.
    store.getState().activateTab('structured-session-3')
    store.setState(buildActiveSurfacePatch(store.getState(), WORKTREE))

    const saved = buildWorkspaceSessionPayload(store.getState())
    const listed = ['session-1', 'session-2', 'session-3']

    expect(saved.activeTabIdByWorktree?.[WORKTREE]).toBe('terminal-1')
    expect(orderOnScreenStructuredAgentSessionsFirst(listed, saved)).toEqual([
      'session-3',
      'session-1',
      'session-2'
    ])
  })
})

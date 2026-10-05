// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ActivityThreadContextMenu,
  getActivityThreadCopyTargets
} from './activity-thread-context-menu'
import type * as ActivityClearCompleted from './activity-clear-completed'
import type { AgentPaneThread } from './activity-thread-types'
import { makeRepo, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

const mocks = vi.hoisted(() => ({ clearActivityThread: vi.fn() }))

vi.mock('./activity-clear-completed', async (importOriginal) => ({
  ...(await importOriginal<typeof ActivityClearCompleted>()),
  clearActivityThread: mocks.clearActivityThread
}))

function makeThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  return {
    paneKey: 'tab-1:leaf-1',
    paneTitle: 'Fix the flaky test',
    worktree: { ...makeWorktree(), branch: 'refs/heads/feat/flaky' },
    repo: makeRepo(),
    tab: makeTab(),
    agentType: 'claude',
    currentAgentState: 'working',
    currentAgentEntry: null,
    responsePreview: '',
    latestTimestamp: 1000,
    latestEvent: null,
    events: [],
    unread: true,
    ...overrides
  }
}

const handlers = {
  onOpen: vi.fn(),
  onJump: vi.fn(),
  onMarkRead: vi.fn(),
  onMarkUnread: vi.fn()
}

function openMenu(thread: AgentPaneThread, canJump = true, disableMarkUnread = false): void {
  render(
    <ActivityThreadContextMenu
      thread={thread}
      canJump={canJump}
      disableMarkUnread={disableMarkUnread}
      {...handlers}
    >
      <div data-testid="row">row</div>
    </ActivityThreadContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId('row'))
}

function menuItem(name: string): HTMLElement {
  return screen.getByRole('menuitem', { name })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ActivityThreadContextMenu', () => {
  it('opens the thread and enables only the applicable read action', () => {
    const thread = makeThread()
    openMenu(thread)

    expect(menuItem('Mark as read').hasAttribute('data-disabled')).toBe(false)
    expect(menuItem('Mark as unread').hasAttribute('data-disabled')).toBe(true)

    fireEvent.click(menuItem('Open'))
    expect(handlers.onOpen).toHaveBeenCalledWith(thread)
  })

  it('offers Go to workspace only for threads with a real workspace', () => {
    openMenu(makeThread(), false)

    expect(screen.queryByRole('menuitem', { name: 'Go to workspace' })).toBeNull()
  })

  it('offers Clear from list only for finished threads', () => {
    const done = makeThread({
      currentAgentState: null,
      paneEntry: {
        state: 'done',
        prompt: '',
        updatedAt: 1000,
        stateStartedAt: 1000,
        agentType: 'claude',
        paneKey: 'tab-1:leaf-1',
        stateHistory: []
      }
    })
    openMenu(done)

    fireEvent.click(menuItem('Clear from list'))
    expect(mocks.clearActivityThread).toHaveBeenCalledWith(done)
    cleanup()

    openMenu(makeThread())
    expect(screen.queryByRole('menuitem', { name: 'Clear from list' })).toBeNull()
  })

  it('copies the title, branch, and path of a real workspace', () => {
    expect(getActivityThreadCopyTargets(makeThread(), true)).toEqual([
      { key: 'title', label: 'Agent title', value: 'Fix the flaky test' },
      { key: 'branch', label: 'Branch', value: 'feat/flaky' },
      { key: 'path', label: 'Path', value: '/repo/wt-1' }
    ])
  })

  it('offers only the title for a synthetic terminal without a workspace', () => {
    const synthetic = makeThread({
      worktree: { ...makeWorktree(), path: '', branch: 'Floating terminal' }
    })

    expect(getActivityThreadCopyTargets(synthetic, false)).toEqual([
      { key: 'title', label: 'Agent title', value: 'Fix the flaky test' }
    ])
  })
})

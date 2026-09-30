import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => {
  const target: { groupKey: string | null } = { groupKey: 'lineage:parent' }
  return {
    target,
    requestScrollAnchor: vi.fn(),
    store: {
      collapsedGroups: new Set<string>(),
      setSidebarOpen: vi.fn(),
      toggleCollapsedGroup: vi.fn()
    }
  }
})

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/sidebar/child-workspaces-toggle-target', () => ({
  resolveChildWorkspacesToggleGroupKey: () => mocks.target.groupKey
}))

vi.mock('@/hooks/requestVirtualizedScrollAnchorRecord', () => ({
  requestVirtualizedScrollAnchorRecord: mocks.requestScrollAnchor
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'parent',
    actions: {
      toggleSidebar: vi.fn(),
      toggleRightSidebar: vi.fn(),
      setRightSidebarOpen: vi.fn(),
      setRightSidebarTab: vi.fn(),
      showRightSidebarFiles: vi.fn(),
      showRightSidebarSearch: vi.fn(),
      openDiffNotesSendMenuForActiveWorktree: vi.fn()
    },
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true
  }
}

function shortcutInput(): ShortcutDispatchInput {
  return { target: null, defaultPrevented: false, preventDefault: vi.fn() }
}

function runToggle(input: ShortcutDispatchInput): boolean | undefined {
  return createAppCommandHandlers(shortcutState(), input).get('sidebar.childWorkspaces.toggle')?.()
}

describe('child workspaces toggle app command', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.target.groupKey = 'lineage:parent'
    mocks.store.collapsedGroups = new Set()
  })

  it('hides the target’s children without forcing the sidebar open', () => {
    const input = shortcutInput()

    expect(runToggle(input)).toBe(true)
    expect(input.preventDefault).toHaveBeenCalledOnce()
    expect(mocks.requestScrollAnchor).toHaveBeenCalledWith('[data-worktree-sidebar]')
    expect(mocks.store.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    expect(mocks.store.setSidebarOpen).not.toHaveBeenCalled()
  })

  it('opens the sidebar when showing hidden children', () => {
    mocks.store.collapsedGroups = new Set(['lineage:parent'])

    expect(runToggle(shortcutInput())).toBe(true)
    expect(mocks.store.toggleCollapsedGroup).toHaveBeenCalledWith('lineage:parent')
    expect(mocks.store.setSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('lets the chord through when the target is in no lineage', () => {
    mocks.target.groupKey = null
    const input = shortcutInput()

    expect(runToggle(input)).toBe(false)
    expect(input.preventDefault).not.toHaveBeenCalled()
    expect(mocks.store.toggleCollapsedGroup).not.toHaveBeenCalled()
  })
})

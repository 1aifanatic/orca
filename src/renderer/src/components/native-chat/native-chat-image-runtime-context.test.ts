import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import {
  resolveNativeChatImageRuntimeContext,
  selectNativeChatImageOwnerState
} from './native-chat-image-runtime-context'
import { useAppStore } from '@/store'
import {
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'

const BRIDGE = { kind: 'bridge', worktreeId: 'wt-1', tabId: 'tab-1' } as const
const FLOATING = {
  kind: 'structured',
  worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
  tabId: 'floating-chat-1'
} as const

function state(): AppState {
  const worktree = worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' })
  return {
    ...useAppStore.getInitialState(),
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    repos: [repoFixture()],
    runtimeEnvironmentCatalogHydrated: true,
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null },
    tabsByWorktree: { 'wt-1': [terminalTabFixture('tab-1', 'wt-1')] },
    worktreesByRepo: { repo: [worktree] }
  }
}

describe('resolveNativeChatImageRuntimeContext', () => {
  it('keeps unrelated store writes out of the image-owner selector', () => {
    const storeState = state()
    const first = selectNativeChatImageOwnerState(storeState, BRIDGE)
    const second = selectNativeChatImageOwnerState(
      {
        ...storeState,
        agentStatusByPaneKey: {} as AppState['agentStatusByPaneKey']
      },
      BRIDGE
    )

    expect(shallow(second, first)).toBe(true)
  })

  it("ignores other workspaces' tab buckets and pins", () => {
    const storeState = state()
    const first = selectNativeChatImageOwnerState(storeState, BRIDGE)
    const second = selectNativeChatImageOwnerState(
      {
        ...storeState,
        tabsByWorktree: { ...storeState.tabsByWorktree, 'wt-other': [] },
        unifiedTabsByWorktree: { 'wt-other': [] },
        structuredSessionLaunchDirectoryByTabId: {
          'other-chat': { sessionId: 's', launchDirectory: '/elsewhere' }
        }
      },
      BRIDGE
    )

    expect(shallow(second, first)).toBe(true)
  })

  it('reuses derived settings when owner inputs are unchanged', () => {
    const storeState = state()
    const first = resolveNativeChatImageRuntimeContext(storeState, BRIDGE)
    const second = resolveNativeChatImageRuntimeContext(storeState, BRIDGE)

    expect(first).not.toBeNull()
    expect(second?.settings).toBe(first?.settings)
    expect(shallow(second, first)).toBe(true)
  })

  it('derives a runtime host from an owner-only route during paired hydration', () => {
    const storeState = state()
    const ownerOnlyWorktree = {
      id: 'wt-1',
      repoId: 'repo',
      path: '/repo/worktree',
      runtimeOwnerEnvironmentId: 'owner-a'
    }
    const ownerState = {
      ...storeState,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      worktreesByRepo: { repo: [ownerOnlyWorktree] },
      runtimeEnvironments: [{ id: 'owner-a' }]
    } as unknown as AppState

    const context = resolveNativeChatImageRuntimeContext(ownerState, BRIDGE)

    expect(context).toMatchObject({
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      expectedExecutionHostId: 'local',
      settings: { activeRuntimeEnvironmentId: 'owner-a' }
    })
  })

  it('resolves a floating chat to its pinned folder on the local host, and nothing before the pin', () => {
    const floatingTab: Tab = {
      id: 'floating-chat-1',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      groupId: 'floating-group',
      contentType: 'agent-session',
      entityId: 'session-1',
      label: 'Codex Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0,
      isPinned: false,
      agentSessionAgent: 'codex'
    }
    const floatingState: AppState = {
      ...state(),
      tabsByWorktree: {},
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      worktreesByRepo: {},
      // Why a focused runtime: floating must stay local even when one is selected.
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' },
      floatingWorkspacePath: '/home/me/changed-setting'
    }

    expect(resolveNativeChatImageRuntimeContext(floatingState, FLOATING)).toBeNull()
    expect(
      resolveNativeChatImageRuntimeContext(
        {
          ...floatingState,
          structuredSessionLaunchDirectoryByTabId: {
            'floating-chat-1': { sessionId: 'session-1', launchDirectory: '/home/me/pinned' }
          }
        },
        FLOATING
      )
    ).toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      worktreePath: '/home/me/pinned',
      expectedExecutionHostId: 'local',
      settings: { activeRuntimeEnvironmentId: null }
    })
  })
})

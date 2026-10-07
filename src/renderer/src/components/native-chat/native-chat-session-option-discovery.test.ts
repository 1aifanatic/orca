import { afterEach, describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { resolveNativeChatModelDiscoveryContext } from './native-chat-session-option-discovery'
import {
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'

const initialState = useAppStore.getInitialState()
const SCOPE = { kind: 'bridge', worktreeId: 'wt-local', tabId: 'tab-1' } as const

function seed(tabsByWorktree: Record<string, TerminalTab[]>): void {
  useAppStore.setState({
    // A globally selected runtime that does not own this workspace.
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-selected' },
    repos: [repoFixture({ connectionId: null, executionHostId: 'local' })],
    worktreesByRepo: {
      repo: [worktreeFixture('wt-local', '/repo/local', { hostId: 'local' })]
    },
    tabsByWorktree
  })
}

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('resolveNativeChatModelDiscoveryContext', () => {
  it("routes discovery through the supplied workspace's owner and snapshot path", () => {
    seed({ 'wt-local': [terminalTabFixture('tab-1', 'wt-local')] })
    expect(resolveNativeChatModelDiscoveryContext(SCOPE)).toMatchObject({
      runtime: {
        worktreeId: 'wt-local',
        worktreePath: '/repo/local',
        settings: { activeRuntimeEnvironmentId: null }
      }
    })
  })

  it('resolves nothing on a scoped miss instead of using the selected runtime or a new location', () => {
    seed({ 'wt-local': [], 'wt-elsewhere': [terminalTabFixture('tab-1', 'wt-elsewhere')] })
    expect(resolveNativeChatModelDiscoveryContext(SCOPE)).toBeNull()
  })
})

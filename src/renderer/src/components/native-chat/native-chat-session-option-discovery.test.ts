import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { resolveNativeChatModelDiscoveryContext } from './native-chat-session-option-discovery'
import {
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

describe('resolveNativeChatModelDiscoveryContext', () => {
  it('uses the current catalog snapshot instead of a getter that closes over another snapshot', () => {
    useAppStore.setState({
      getKnownWorktreeById: () => worktreeFixture('wt-local', '/newer-snapshot'),
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-selected' },
      repos: [repoFixture({ connectionId: null, executionHostId: 'local' })],
      tabsByWorktree: { 'wt-local': [terminalTabFixture('tab-1', 'wt-local')] },
      worktreesByRepo: {
        repo: [worktreeFixture('wt-local', '/repo/local', { hostId: 'local' })]
      }
    })

    expect(resolveNativeChatModelDiscoveryContext('tab-1')).toMatchObject({
      runtime: {
        worktreeId: 'wt-local',
        worktreePath: '/repo/local',
        settings: { activeRuntimeEnvironmentId: null }
      }
    })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import { clearSshPlainSshMode, setSshPlainSshMode } from '../ssh/ssh-plain-ssh-mode'

afterEach(() => clearSshPlainSshMode('conn-1'))

function runtimeWithSshPty(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store)
  runtime.registerPty('ssh:conn-1@@pty-1', TEST_WORKTREE_ID, 'conn-1', {
    tabId: 'tab-1',
    leafId: HEADLESS_LEAF_ID,
    incarnationId: 'inc-1'
  })
  return runtime
}

describe('whether a pane’s host can find a launched agent in front', () => {
  it('can over an SSH connection to the Orca remote server', () => {
    expect(runtimeWithSshPty().launchedAgentHostProvesAgent('ssh:conn-1@@pty-1')).toBe(true)
  })

  it('cannot over plain SSH, whose terminals report no foreground process', () => {
    setSshPlainSshMode('conn-1', { reason: 'no_runtime', message: 'plain' })
    expect(runtimeWithSshPty().launchedAgentHostProvesAgent('ssh:conn-1@@pty-1')).toBe(false)
  })
})

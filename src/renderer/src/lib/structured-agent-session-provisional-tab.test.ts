import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { AgentSessionLaunchPlan } from './agent-session-launch-plan'
import type { StructuredAgentLaunchSettlement } from './structured-agent-launch-settlement'

const mocks = vi.hoisted(() => ({
  createUnifiedTab: vi.fn(),
  replaceUnstartedStructuredChat: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {},
      createUnifiedTab: mocks.createUnifiedTab,
      setActiveTabType: vi.fn()
    })
  }
}))
vi.mock('@/lib/structured-agent-session-unstarted-launch', () => ({
  replaceUnstartedStructuredChat: mocks.replaceUnstartedStructuredChat
}))

import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'

function planSettlingAs(settlement: StructuredAgentLaunchSettlement): AgentSessionLaunchPlan {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: begin() is the only member this path calls.
  return {
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    begin: () => ({
      sessionId: 'claude_1',
      executionHostId: 'runtime:server-1',
      settlement: Promise.resolve(settlement),
      cancel: vi.fn()
    }),
    launch: vi.fn()
  } as unknown as AgentSessionLaunchPlan
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createUnifiedTab.mockImplementation(
    (worktreeId: string, _type: string, tab: Partial<Tab>) => ({ ...tab, worktreeId })
  )
})

describe('a provisional structured chat tab', () => {
  it('carries the host the launch was sent to', () => {
    beginStructuredAgentSessionProvisionalLaunch({
      plan: planSettlingAs({ kind: 'structured', sessionId: 'claude_1' }),
      hooks: {}
    })

    expect(mocks.createUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'agent-session',
      expect.objectContaining({ executionHostId: 'runtime:server-1' })
    )
  })

  it('hands a launch that failed before creating anything to the unstarted-chat handling', async () => {
    const error = new Error('declined')
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: planSettlingAs({ kind: 'failed', error }),
      hooks: {}
    })
    await launch?.settlement

    expect(mocks.replaceUnstartedStructuredChat).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        sessionId: 'claude_1',
        error
      })
    )
  })

  it('leaves a chat that started alone', async () => {
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan: planSettlingAs({ kind: 'structured', sessionId: 'claude_1' }),
      hooks: {}
    })
    await launch?.settlement

    expect(mocks.replaceUnstartedStructuredChat).not.toHaveBeenCalled()
  })
})

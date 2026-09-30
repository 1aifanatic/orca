import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'

const mocks = vi.hoisted(() => ({
  tabs: new Array<Tab>(),
  closeUnifiedTab: vi.fn(),
  launchAgentInNewTab: vi.fn(),
  deleteLaunch: vi.fn(() => true),
  discardOutbox: vi.fn(),
  retry: vi.fn(() => true),
  outbox: new Array<{ source?: 'launch'; body: { blocks: { type: 'text'; text: string }[] } }>(),
  launchPromise: Promise.resolve<unknown>(undefined),
  toastInfo: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo, error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: { value0?: string }) =>
    fallback.replace('{{value0}}', options?.value0 ?? '')
}))
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'claude', label: 'Claude' }]
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: { 'wt-1': mocks.tabs },
      closeUnifiedTab: mocks.closeUnifiedTab,
      clearNativeChatLaunchDraft: vi.fn()
    })
  }
}))
vi.mock('@/lib/structured-agent-session-launch-registry', () => ({
  getStructuredLaunchStateBySessionId: (sessionId: string) =>
    sessionId === 'claude_1'
      ? {
          intent: { worktreeId: 'wt-1', sessionId, agent: 'claude', target: { kind: 'local' } },
          promise: mocks.launchPromise
        }
      : undefined,
  deleteStructuredLaunchStateIfCurrent: mocks.deleteLaunch,
  notifyStructuredLaunchListeners: vi.fn()
}))
vi.mock('@/components/native-chat/structured-agent-session-outbox-storage', () => ({
  discardStructuredAgentSessionLaunchOutbox: mocks.discardOutbox,
  readOutbox: () => mocks.outbox
}))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  retryStructuredAgentSessionLaunch: mocks.retry
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))

import {
  StructuredAgentSessionCreateRefusalError,
  StructuredAgentSessionHostDeclinedError,
  StructuredAgentSessionHostUnreachableError
} from '@/lib/launch-structured-agent-session'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import {
  replaceUnstartedStructuredChat,
  retryStructuredChatLaunch
} from './structured-agent-session-unstarted-launch'

const plan = adoptAgentSessionLaunchVerdict({
  route: 'structured-native-chat',
  agent: 'claude',
  worktreeId: 'wt-1',
  prompt: 'fix the flaky test',
  promptDelivery: 'auto-submit'
})

function chatTab(): Tab {
  return {
    id: 'agent-session:claude_1',
    entityId: 'claude_1',
    groupId: 'group-split',
    worktreeId: 'wt-1',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function settleWith(error: unknown): void {
  replaceUnstartedStructuredChat({
    plan,
    worktreeId: 'wt-1',
    sessionId: 'claude_1',
    error
  })
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tabs.splice(0, Infinity, chatTab())
  mocks.outbox.splice(0)
})

describe('a structured chat whose launch ended before anything was created', () => {
  it("gives a declining paired server's workspace its terminal, and says why", async () => {
    settleWith(new StructuredAgentSessionHostDeclinedError('runtime:server-1'))
    await flush()

    // Nothing was created, so the launch is dropped rather than tombstoned.
    expect(mocks.deleteLaunch).toHaveBeenCalledOnce()
    expect(mocks.discardOutbox).toHaveBeenCalledWith('claude_1')
    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('agent-session:claude_1')
    expect(mocks.toastInfo).toHaveBeenCalledWith('Opened Claude in a terminal', {
      description: "This server can't run a Claude chat in this workspace."
    })
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        groupId: 'group-split',
        prompt: 'fix the flaky test',
        promptDelivery: 'auto-submit',
        agentSessionLaunchPlan: expect.objectContaining({ route: 'terminal-tui' })
      })
    )
  })

  it('closes the chat an unreachable host never received, leaving the failure toast', async () => {
    settleWith(new StructuredAgentSessionHostUnreachableError('offline', 'runtime_unavailable'))
    await flush()

    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('agent-session:claude_1')
    expect(mocks.toastInfo).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it.each([
    ['this machine declining', new StructuredAgentSessionHostDeclinedError('local')],
    ['a refused create', new StructuredAgentSessionCreateRefusalError('refused')]
  ])('keeps the failed chat and its Retry after %s', async (_name, error) => {
    settleWith(error)
    await flush()

    expect(mocks.deleteLaunch).not.toHaveBeenCalled()
    expect(mocks.closeUnifiedTab).not.toHaveBeenCalled()
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('opens nothing once the user has closed the chat', async () => {
    mocks.tabs.splice(0)
    settleWith(new StructuredAgentSessionHostDeclinedError('runtime:server-1'))
    await flush()

    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(mocks.toastInfo).not.toHaveBeenCalled()
  })

  // A launch restored after a reload has no first settlement; its Retry is where the host answers.
  it('gives a retried launch the same terminal when the paired server declines it', async () => {
    mocks.outbox.push({
      source: 'launch',
      body: { blocks: [{ type: 'text', text: 'fix the flaky test' }] }
    })
    mocks.launchPromise = Promise.reject(
      new StructuredAgentSessionHostDeclinedError('runtime:server-1')
    )

    expect(retryStructuredChatLaunch('wt-1', 'claude_1')).toBe(true)
    await flush()

    expect(mocks.retry).toHaveBeenCalledWith('wt-1', 'claude_1')
    expect(mocks.closeUnifiedTab).toHaveBeenCalledWith('agent-session:claude_1')
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        prompt: 'fix the flaky test',
        promptDelivery: 'auto-submit'
      })
    )
  })
})

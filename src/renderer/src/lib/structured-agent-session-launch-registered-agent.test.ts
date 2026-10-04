// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/agent-catalog', () => ({ getAgentCatalog: () => [{ id: 'grok', label: 'Grok' }] }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local',
  refreshLocalStructuredSessionTabs: vi.fn(async () => [])
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ unifiedTabsByWorktree: {} }), subscribe: () => () => {} }
}))

import {
  hasStructuredAgentLaunchInWorktree,
  startStructuredAgentLaunch,
  useStructuredAgentLaunchPendingAgents
} from './structured-agent-session-launch'

async function pendingAgents(worktreeId: string): Promise<string[]> {
  let seen: string[] = []
  function Probe(): null {
    seen = [...useStructuredAgentLaunchPendingAgents(worktreeId)]
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  act(() => root.unmount())
  return seen
}

describe('a launch of a host-registered agent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.call.mockImplementation(async (_target: unknown, method: string) =>
      method === 'agentSession.createSupport' ? { supported: true } : new Promise(() => {})
    )
  })

  it('creates the chat for that agent and counts as a chat starting in the worktree', async () => {
    const worktreeId = 'wt-grok'
    expect(hasStructuredAgentLaunchInWorktree(worktreeId)).toBe(false)

    const launch = startStructuredAgentLaunch(worktreeId, 'grok')
    await vi.waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        expect.anything(),
        'agentSession.create',
        expect.objectContaining({ agent: 'grok', worktree: `id:${worktreeId}` })
      )
    )

    expect(launch.sessionId.startsWith('grok_')).toBe(true)
    expect(hasStructuredAgentLaunchInWorktree(worktreeId)).toBe(true)
    expect(hasStructuredAgentLaunchInWorktree('wt-other')).toBe(false)
    expect(await pendingAgents(worktreeId)).toEqual(['grok'])
    expect(await pendingAgents('wt-other')).toEqual([])
  })
})

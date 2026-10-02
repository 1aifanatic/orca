// @vitest-environment happy-dom

// The + menu disables an agent and spins its icon while that agent's chat is starting. A failed
// start is kept for its Retry, but it is not starting: the menu must let the user launch again.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'

const mocks = vi.hoisted(() => ({
  createIntent: vi.fn(),
  retryIntent: vi.fn(),
  launch: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), message: vi.fn() } }))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    createStructuredAgentSessionLaunchIntent: mocks.createIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    restoreStructuredAgentSessionLaunchIntent: vi.fn(),
    abandonStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: vi.fn(async () => [])
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ unifiedTabsByWorktree: {} }),
    subscribe: () => () => {}
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [{ id: 'codex', label: 'Codex' }]
}))

import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-agent-session'
import {
  getStructuredAgentLaunchStatus,
  startStructuredAgentLaunch
} from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

function launchIntent(worktreeId: string): StructuredAgentSessionLaunchIntent {
  const sessionId = `session-${worktreeId}`
  return {
    worktreeId,
    sessionId,
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: `fingerprint-${sessionId}`
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

describe('the launch status the + menu reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    mocks.retryIntent.mockImplementation((prior: StructuredAgentSessionLaunchIntent) => prior)
  })

  it('reads a failed start as failed, not starting, and a retry as starting again', async () => {
    const worktreeId = 'wt-failed-status'
    mocks.createIntent.mockReturnValueOnce(launchIntent(worktreeId))
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
      .mockReturnValueOnce(new Promise(() => {}))

    startStructuredAgentLaunch(worktreeId, 'codex')
    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
    await flushLaunchSettlement()
    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('failed')

    // Launching the agent again retries the failed chat rather than opening a second one.
    const retried = startStructuredAgentLaunch(worktreeId, 'codex')
    expect(retried.sessionId).toBe(`session-${worktreeId}`)
    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
  })

  it('reads a pending resume beside a failed blank launch as starting', async () => {
    const worktreeId = 'wt-failed-beside-resume'
    mocks.createIntent
      .mockReturnValueOnce(launchIntent(worktreeId))
      .mockReturnValueOnce({ ...launchIntent(`${worktreeId}-resume`), worktreeId })
    mocks.launch
      .mockRejectedValueOnce(new StructuredAgentSessionCreateRefusalError('refused'))
      .mockReturnValueOnce(new Promise(() => {}))

    startStructuredAgentLaunch(worktreeId, 'codex')
    await flushLaunchSettlement()
    startStructuredAgentLaunch(worktreeId, 'codex', {
      resumeFrom: { providerSessionId: 'thread-1' }
    })

    expect(getStructuredAgentLaunchStatus(worktreeId, 'codex')).toBe('pending')
  })
})

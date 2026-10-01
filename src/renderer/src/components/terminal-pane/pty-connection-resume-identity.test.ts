import { AGENT_RESUME_IDENTITY_ERROR } from '../../../../shared/agent-resume-identity'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const {
  resetAndRefreshAllTerminalWebglAtlases,
  scheduleTerminalWebglAtlasRecovery,
  scheduleRuntimeGraphSync,
  shouldSeedCacheTimerOnInitialTitle,
  toastInfo,
  notifyCodexPaneBoundForStaleSweep
} = vi.hoisted(() => ({
  resetAndRefreshAllTerminalWebglAtlases: vi.fn(),
  scheduleTerminalWebglAtlasRecovery: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  shouldSeedCacheTimerOnInitialTitle: vi.fn(() => false),
  toastInfo: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync
}))

vi.mock('@/lib/pane-manager/pane-manager-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resetAndRefreshAllTerminalWebglAtlases
}))

vi.mock('./terminal-webgl-atlas-recovery', () => ({
  scheduleTerminalWebglAtlasRecovery
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

vi.mock('./cache-timer-seeding', () => ({
  shouldSeedCacheTimerOnInitialTitle
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo
  }
}))

vi.mock('@/lib/codex-stale-pane-sweep', () => ({
  notifyCodexPaneBoundForStaleSweep
}))

// Why: the working→idle test invokes the real useNotificationDispatch hook outside React, so useCallback must pass through (safe suite-wide: no test here renders React).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(
    (_environmentId: string, options: Record<string, unknown>) => {
      createdTransportOptions.push(options)
      const nextTransport = transportFactoryQueue.shift()
      if (!nextTransport) {
        throw new Error('No mock transport queued')
      }
      return nextTransport
    }
  )
}))

// Why: stub only getEagerPtyBufferHandle so tests can simulate a live eager buffer (adopt path) without standing up the real IPC dispatcher.
vi.mock('./pty-dispatcher', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    getEagerPtyBufferHandle: vi.fn(() => undefined)
  }
})

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

describe('connectPanePty', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it.each(['legacy', 'mixed'] as const)(
    'refuses a %s saved identity without typing and still permits a fresh launch',
    async (kind) => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState.sleepingAgentSessionsByPaneKey = {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'claude',
          providerSession: {
            key: 'session_id',
            id: '0195f2ce-1111-4000-8000-000000000001',
            ...(kind === 'mixed' ? { resumeIdentity: { agent: 'codex', connectionId: null } } : {})
          },
          prompt: 'saved work',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'saved-pty' }] }
      const refused = createMockTransport('saved-pty')
      transportFactoryQueue.push(refused)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'saved-pty' }
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The existing connection harness supplies the pane, manager and dependency methods exercised by connectPanePty.
      connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
      await flushAsyncTicks(20)
      expect(deps.onPtyErrorRef.current).toHaveBeenCalledWith(1, AGENT_RESUME_IDENTITY_ERROR)
      expect(refused.sendInput).not.toHaveBeenCalled()
      expect(refused.connect).toHaveBeenCalled()
      for (const [options] of refused.connect.mock.calls) {
        expect(options.command).toBeUndefined()
      }
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()

      const fresh = createMockTransport('fresh-pty')
      transportFactoryQueue.push(fresh)
      const freshDeps = createDeps({
        startup: { command: 'codex', launchAgent: 'codex', startupCommandDelivery: 'shell-ready' }
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Same connection harness; an explicit pending startup bypasses automatic recovery.
      connectPanePty(createPane(1) as never, createManager(1) as never, freshDeps as never)
      await flushAsyncTicks(20)
      expect(freshDeps.onPtyErrorRef.current).not.toHaveBeenCalled()
      expect(createdTransportOptions.at(-1)).toMatchObject({
        command: 'codex',
        launchAgent: 'codex'
      })
      expect(fresh.connect).toHaveBeenCalled()
    }
  )
})

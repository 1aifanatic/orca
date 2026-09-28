// Codex's turn and subagents run in its app-server, which a shared background server keeps
// running after the TUI exits ("Run in background", or "Exit" with a subagent still running). The
// TUI's exit is therefore not the end of a Codex row that still shows work: Codex's own records,
// read by the execution host, end it.
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
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

  const ROLLOUT = '/home/user/.codex/sessions/2026/09/27/rollout-2026-09-27T10-00-00-root.jsonl'
  const providerSession = { key: 'session_id' as const, id: 'root', transcriptPath: ROLLOUT }

  async function exitTuiWithRow(
    ptyId: string,
    row: Pick<
      AgentStatusEntry,
      'state' | 'agentType' | 'mainAgent' | 'subagents' | 'providerSession'
    >
  ): Promise<string> {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
    vi.mocked(window.api.agentStatus.reconcileEndedProcess).mockClear()
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    connectPanePty(
      createPane(1) as never,
      createManager(1) as never,
      createDeps({ isVisibleRef: { current: false } }) as never
    )
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()

    mockStoreState.agentStatusByPaneKey[paneKey] = {
      ...row,
      paneKey,
      prompt: 'go',
      updatedAt: 1_000,
      stateStartedAt: 1_000,
      stateHistory: []
    }
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'codex' }
    }
    mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
      delete mockStoreState.agentStatusByPaneKey[key]
    })

    // The TUI exits to the shell: 133;D, then the process check confirms a shell.
    dataCallbackRef.current?.('\x1b]133;D;0\x07')
    await vi.advanceTimersByTimeAsync(350)
    await flushAsyncTicks()
    return paneKey
  }

  it.each<[string, Pick<AgentStatusEntry, 'mainAgent' | 'subagents'>]>([
    ['still working ("Run in background")', { mainAgent: { state: 'working', stateStartedAt: 1 } }],
    [
      'cancelled with its subagent still running ("Exit")',
      {
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1 },
        subagents: [{ id: 'child-1', state: 'working', startedAt: 1 }]
      }
    ]
  ])('keeps a Codex row %s when its TUI exits', async (_label, row) => {
    const paneKey = await exitTuiWithRow('pty-codex-tui-exit-working', {
      ...row,
      state: 'working',
      agentType: 'codex',
      providerSession
    })

    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
    expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({ state: 'working' })
    // The CLI itself is gone, so its launch record goes with it.
    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
  })

  it.each<[string, Pick<AgentStatusEntry, 'state' | 'agentType' | 'providerSession'>]>([
    ['a settled Codex row', { state: 'done', agentType: 'codex', providerSession }],
    ['a Codex row that names no rollout to settle it', { state: 'working', agentType: 'codex' }],
    ['any other agent still working', { state: 'working', agentType: 'claude', providerSession }]
  ])('retires %s when its CLI exits', async (_label, row) => {
    const paneKey = await exitTuiWithRow('pty-cli-exit-retires', row)

    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
    expect(window.api.agentStatus.reconcileEndedProcess).toHaveBeenCalledWith(paneKey)
  })
})

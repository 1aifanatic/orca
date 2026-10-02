// @vitest-environment happy-dom

// A host status snapshot reaches every chat's projection at once: its rows must land as one store
// publication, not one per row, or every reader of the status map runs once per row.

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import type { AppState } from '@/store/types'
import type * as RuntimeRpcClientModule from '@/runtime/runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  removeAgentStatus: vi.fn(),
  setAgentStatus: vi.fn(),
  store: null as null | {
    getState: () => AppState
    setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
    subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void
  },
  subscribeStatus: vi.fn(),
  subscribeTranscript: vi.fn(),
  supportsCapability: vi.fn(),
  unsubscribe: vi.fn()
}))

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  const { setAgentStatus, removeAgentStatus, transactAgentStatuses } = useAppStore.getState()
  useAppStore.setState({
    setAgentStatus: (...args) => {
      mocks.setAgentStatus(...args)
      setAgentStatus(...args)
    },
    // The bridge writes rows through one transaction per tick; each applied row is one write.
    transactAgentStatuses: (operation) =>
      transactAgentStatuses((transaction) =>
        operation({
          ...transaction,
          apply: (update) => {
            if (update.kind !== 'providerSession') {
              mocks.setAgentStatus(update.paneKey, update.payload)
            }
            return transaction.apply(update)
          }
        })
      ),
    removeAgentStatus: (paneKey) => {
      mocks.removeAgentStatus(paneKey)
      removeAgentStatus(paneKey)
    }
  })
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClientModule>()),
  runtimeEnvironmentSupportsCapability: mocks.supportsCapability
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: mocks.subscribeTranscript,
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from './StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: 'session-1',
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

const providerSession = { key: 'session_id', id: '01a002e9-9a1c-7d42-a642-e481f64446f1' } as const

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: 'wt-1',
    agent: 'codex',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'hello',
    providerSession,
    updatedAt: 1,
    ...overrides
  }
}

function statuses(): AgentStatusEntry[] {
  return Object.values(mocks.store?.getState().agentStatusByPaneKey ?? {})
}

/** The host side of the most recent status subscription. */
function feed(index = 0): { target: unknown; emit: (event: AgentSessionStatusEvent) => void } {
  const call = mocks.subscribeStatus.mock.calls[index]
  if (!call) {
    throw new Error('status feed not subscribed')
  }
  return { target: call[0], emit: call[1] as (event: AgentSessionStatusEvent) => void }
}

describe('a status snapshot of many chats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      testRuntimeOwner: null,
      unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
  })

  it("applies a snapshot of every listed chat's status as one status publication", async () => {
    const tabs = Array.from({ length: 40 }, (_, index) => ({
      ...structuredTab,
      id: `structured-tab-${index}`,
      entityId: `session-${index}`
    }))
    mocks.store?.setState({ unifiedTabsByWorktree: { 'wt-1': tabs } })
    render(<StructuredAgentSessionStatusBridge />)
    await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
    // Every publication of the status map re-runs every reader of it, so a row each is a burst.
    let publications = 0
    const stop = mocks.store!.subscribe((state, previous) => {
      if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
        publications += 1
      }
    })

    await act(async () =>
      feed().emit({
        type: 'snapshot',
        sessions: tabs.map((tab, index) =>
          summary({ sessionId: tab.entityId, updatedAt: index + 1 })
        )
      })
    )
    stop()

    expect(statuses()).toHaveLength(tabs.length)
    expect(publications).toBe(1)
  })
})

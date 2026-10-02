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
import type * as AgentStatusProjectionModule from '@/runtime/sync-runtime-graph/agent-status-projection'

const mocks = vi.hoisted(() => ({
  mobileStatusProjections: vi.fn(),
  removeAgentStatus: vi.fn(),
  setAgentStatus: vi.fn(),
  setGeneratedTitle: vi.fn(),
  setGeneratedTitles: vi.fn(),
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
  const {
    setAgentStatus,
    removeAgentStatus,
    transactAgentStatuses,
    setGeneratedTabTitleFromAgentPrompt,
    setGeneratedTabTitlesFromAgentPrompts
  } = useAppStore.getState()
  useAppStore.setState({
    setGeneratedTabTitleFromAgentPrompt: (...args) => {
      mocks.setGeneratedTitle(...args)
      setGeneratedTabTitleFromAgentPrompt(...args)
    },
    setGeneratedTabTitlesFromAgentPrompts: (updates) => {
      mocks.setGeneratedTitles(updates)
      setGeneratedTabTitlesFromAgentPrompts(updates)
    },
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

vi.mock('@/runtime/sync-runtime-graph/agent-status-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusProjectionModule>()
  return {
    ...actual,
    buildRuntimeMobileAgentStatusProjection: (
      ...args: Parameters<typeof actual.buildRuntimeMobileAgentStatusProjection>
    ) => {
      mocks.mobileStatusProjections()
      return actual.buildRuntimeMobileAgentStatusProjection(...args)
    }
  }
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
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey
} from '@/runtime/sync-runtime-graph/sync-key'
import { getDefaultSettings } from '../../../../shared/constants'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'

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

// A seeded launch lists a few hundred chats; the host's first snapshot carries all of them.
const CHAT_COUNT = 247

const tabs = Array.from({ length: CHAT_COUNT }, (_, index) => ({
  ...structuredTab,
  id: `structured-tab-${index}`,
  entityId: `session-${index}`
}))

function chatSummaries(): AgentSessionStatusSummary[] {
  return tabs.map((tab, index) =>
    summary({
      sessionId: tab.entityId,
      status: index % 3 === 0 ? 'idle' : 'working',
      latestPrompt: `prompt ${index}`,
      updatedAt: index + 1
    })
  )
}

/** Every store notification, and how many changed the status map. */
function countPublications(): { all: number; status: number; stop: () => void } {
  const counts = { all: 0, status: 0, stop: () => {} }
  counts.stop = mocks.store!.subscribe((state, previous) => {
    counts.all += 1
    if (state.agentStatusByPaneKey !== previous.agentStatusByPaneKey) {
      counts.status += 1
    }
  })
  return counts
}

/** The mobile session sync's store subscriber, which rebuilds the status projection per change. */
function subscribeMobileSync(): () => void {
  let previousKey = getRuntimeMobileSessionSyncKey(mocks.store!.getState())
  return mocks.store!.subscribe((state, previous) => {
    if (!canSkipRuntimeMobileSessionSyncKeyBuild(state, previous)) {
      previousKey = getRuntimeMobileSessionSyncKey(state, previous, previousKey)
    }
  })
}

async function renderBridge(): Promise<void> {
  render(<StructuredAgentSessionStatusBridge />)
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
}

describe('a status snapshot of many chats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
    mocks.supportsCapability.mockResolvedValue(true)
    // The status evidence clock, so rows written on different ticks compare equal.
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    mocks.store?.setState({
      agentStatusByPaneKey: {},
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      testRuntimeOwner: null,
      unifiedTabsByWorktree: { 'wt-1': tabs }
    })
  })

  afterEach(() => {
    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    vi.restoreAllMocks()
  })

  it("applies a snapshot of every listed chat's status as one publication", async () => {
    await renderBridge()
    const stopMobileSync = subscribeMobileSync()
    mocks.mobileStatusProjections.mockClear()
    // Every publication re-runs every store reader, so a publication per row is the burst.
    const publications = countPublications()

    await act(async () => feed().emit({ type: 'snapshot', sessions: chatSummaries() }))
    publications.stop()
    stopMobileSync()

    expect(statuses()).toHaveLength(CHAT_COUNT)
    expect(publications.status).toBe(1)
    expect(publications.all).toBe(1)
    expect(mocks.mobileStatusProjections).toHaveBeenCalledOnce()
    // The rows' generated-title requests go out as one batch, not a call per row.
    expect(mocks.setGeneratedTitle).not.toHaveBeenCalled()
    expect(mocks.setGeneratedTitles).toHaveBeenCalledOnce()
    expect(mocks.setGeneratedTitles.mock.calls[0][0]).toHaveLength(CHAT_COUNT)
  })

  it('writes the same rows as a status event per chat', async () => {
    await renderBridge()
    await act(async () => feed().emit({ type: 'snapshot', sessions: chatSummaries() }))
    const fromSnapshot = mocks.store!.getState().agentStatusByPaneKey

    cleanup()
    resetStructuredAgentSessionStatusFeedsForTests()
    mocks.subscribeStatus.mockClear()
    mocks.store?.setState({ agentStatusByPaneKey: {} })
    await renderBridge()
    const publications = countPublications()
    for (const session of chatSummaries()) {
      await act(async () => feed().emit({ type: 'status', session }))
    }
    publications.stop()

    expect(publications.status).toBe(CHAT_COUNT)
    expect(mocks.store!.getState().agentStatusByPaneKey).toEqual(fromSnapshot)
  })

  it('still removes a row, and applies a later single update on the next tick', async () => {
    await renderBridge()
    await act(async () => feed().emit({ type: 'snapshot', sessions: chatSummaries() }))
    const [first, second] = chatSummaries()
    const paneKey = (tab: (typeof tabs)[number]): string =>
      structuredAgentSessionPaneKey(tab.id, tab.entityId)
    expect(mocks.store!.getState().agentStatusByPaneKey[paneKey(tabs[0])]).toBeDefined()

    await act(async () => feed().emit({ type: 'status', session: { ...first, status: null } }))
    expect(mocks.removeAgentStatus).toHaveBeenCalledWith(paneKey(tabs[0]))
    expect(mocks.store!.getState().agentStatusByPaneKey[paneKey(tabs[0])]).toBeUndefined()

    const publications = countPublications()
    await act(async () =>
      feed().emit({ type: 'status', session: { ...second, status: 'idle', updatedAt: 9_999 } })
    )
    publications.stop()
    expect(publications.status).toBe(1)
    expect(mocks.store!.getState().agentStatusByPaneKey[paneKey(tabs[1])]).toMatchObject({
      state: 'done',
      updatedAt: 9_999
    })
    expect(statuses()).toHaveLength(CHAT_COUNT - 1)
  })
})

// @vitest-environment happy-dom
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { StructuredNotificationRead } from '../../../../shared/notification-settings-types'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import {
  structuredAgentSessionPaneKey,
  projectStructuredAgentSessionStatusState
} from '../../../../shared/structured-agent-session-projection'
import {
  agentSessionPromptAttentionKey,
  agentSessionAttentionSubjectPrefix
} from '../../../../shared/agent-session-attention'
import { StructuredAgentSessionTurnCompletionFeed } from '../../../../main/native-chat/agent-session-wire/structured-agent-session-turn-completion-feed'
import {
  RuntimeMobileNotificationController,
  type MobileNotificationEvent
} from '../../../../main/runtime/runtime-mobile-notification-controller'
import { createStructuredAttentionMobileDelivery } from '../../../../main/runtime/structured-agent-session-mobile-attention'
import {
  call,
  hostCalls,
  installStructuredHostStub,
  clearStructuredHostStub,
  STRUCTURED_CLIENT,
  SESSION
} from '../../../../main/runtime/rpc/methods/structured-agent-session-rpc.test-fixture'
import {
  makeUnifiedTab,
  makeTabGroup,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'

const transport = vi.hoisted(() => ({
  call: vi.fn(),
  away: vi.fn(),
  supports: vi.fn(),
  dismiss: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original()),
  callRuntimeRpc: transport.call,
  runtimeEnvironmentSupportsCapability: transport.supports
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => RUNTIME_CAPABILITIES,
  ensureLocalRuntimeCapabilities: async () => RUNTIME_CAPABILITIES
}))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})
import { useAppStore } from '@/store'
import { useAutoAckViewedAgent } from '@/hooks/useAutoAckViewedAgent'
import { StructuredAgentSessionAttentionBridge } from './StructuredAgentSessionAttentionBridge'
import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'
import { resetStructuredAgentSessionTurnCompletionFeedsForTests } from '@/runtime/structured-agent-session-turn-completion-feed'

const WORKSPACE = 'repo1::/tmp/wt'
const TAB = 'chat'
const SUBJECT = structuredAgentSessionPaneKey(TAB, SESSION)
const TARGET = { kind: 'local' } as const
const SCOPE = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: WORKSPACE,
  workspaceKind: 'git-worktree'
} as const
let directory: string
let controller: RuntimeMobileNotificationController
let events: MobileNotificationEvent[]
let items: AgentJournalRenderItem[]
let sequence: number
let hostFeed: StructuredAgentSessionTurnCompletionFeed
let completion: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
let journal: ((response: RuntimeRpcResponse<unknown>) => void) | undefined
let hydrate: (() => void) | undefined

function history(): AgentSessionHistoryPage {
  return {
    sessionId: SESSION,
    epoch: 'journal-a',
    direction: 'tail',
    items: [...items],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'journal-a', sequence: 1 },
      newest: { epoch: 'journal-a', sequence },
      nextCursor: { epoch: 'journal-a', sequence: 1 }
    },
    liveCursor: { epoch: 'journal-a', sequence },
    hasOlder: false,
    hasNewer: false
  }
}
function addPrompt(id: string): void {
  items = [
    ...items,
    {
      itemId: id,
      revision: 1,
      sequence: ++sequence,
      observedAt: sequence,
      body: {
        kind: 'approval',
        title: 'Allow?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
  ]
  hostFeed.observe(SESSION)
}
function publishView(): void {
  journal?.({
    id: 'journal',
    ok: true,
    result: { type: 'snapshot', sessionId: SESSION, page: history(), fence: 1 }
  })
}
function ReadSurface({
  viewed,
  target = TARGET
}: {
  viewed: boolean
  target?: RuntimeClientTarget
}): null {
  useStructuredAgentSessionRead({
    sessionId: SESSION,
    target,
    isVisible: true,
    isViewed: viewed
  })
  return null
}
function AttentionPolicy(): null {
  useAutoAckViewedAgent(false)
  return null
}
function readCalls(): number {
  return transport.call.mock.calls.filter(
    ([, method]) => method === 'agentSession.acknowledgeAttention'
  ).length
}
function dismissIds(): string[] {
  return events.filter((event) => event.type === 'dismiss').map((event) => event.notificationId)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  directory = mkdtempSync(join(tmpdir(), 'orca-renderer-read-'))
  installStructuredHostStub()
  hostCalls.attentionSubjectPrefix.mockReturnValue(
    agentSessionAttentionSubjectPrefix(SCOPE, SESSION)
  )
  controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(directory)
  events = []
  controller.onDispatched((event) => events.push(event))
  items = [
    {
      itemId: 'user',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Work' }] }
    },
    {
      itemId: 'turn',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
    }
  ]
  sequence = 2
  completion = undefined
  journal = undefined
  hydrate = undefined
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionTurnCompletionFeedsForTests()
  const delivery = createStructuredAttentionMobileDelivery({
    readNotificationSettings: () => ({
      enabled: true,
      agentTaskComplete: true,
      terminalBell: true,
      suppressWhenFocused: false,
      customSoundId: 'system',
      customSoundPath: null,
      customSoundVolume: 1,
      mutedNotificationSourceIds: []
    }),
    readWorkspaceLabels: () => ({}),
    dispatch: (event) => controller.dispatch(event),
    reconcile: (state) => controller.reconcileStructuredPromptAttention(state),
    now: () => 42
  })
  hostFeed = new StructuredAgentSessionTurnCompletionFeed({
    sessions: new Map([
      [
        SESSION,
        {
          journal: { cursor: () => ({ epoch: 'journal-a', sequence }) },
          params: { location: SCOPE }
        }
      ]
    ]),
    readStatusState: () => projectStructuredAgentSessionStatusState(items),
    now: () => 42
  })
  hostFeed.subscribe({
    id: 'mobile-and-renderer',
    includePrompts: true,
    onState: delivery.reconcile,
    emit: (event) => {
      if (event.type !== 'end') {
        delivery.deliver(event, undefined)
        completion?.({ id: 'completion', ok: true, result: event })
      }
    }
  })
  hostFeed.observe(SESSION)
  transport.away.mockResolvedValue(false)
  transport.supports.mockResolvedValue(true)
  transport.dismiss.mockResolvedValue({ dismissed: 0 })
  const subscribe = async (
    request: { method: string },
    emit: (response: RuntimeRpcResponse<unknown>) => void
  ) => {
    if (request.method === 'agentSession.subscribeTurnCompletions') {
      completion = emit
    } else {
      journal = emit
    }
    return { unsubscribe: () => {} }
  }
  vi.stubGlobal('api', {
    gh: {},
    runtime: { subscribe },
    runtimeEnvironments: {
      subscribe: (
        request: { method: string },
        callbacks: { onResponse: (response: RuntimeRpcResponse<unknown>) => void }
      ) => subscribe(request, callbacks.onResponse)
    },
    notifications: {
      dispatch: async () => ({ delivered: true }),
      dismiss: transport.dismiss,
      getDesktopAwayState: transport.away
    }
  })
  transport.call.mockImplementation(async (_target, method: string, params: unknown) => {
    if (method === 'agentSession.history') {
      return await new Promise((resolve) => {
        hydrate = () => resolve({ ok: true, page: history() })
      })
    }
    const reply = await call(method, params, STRUCTURED_CLIENT, {
      retireStructuredAttention: controller.retireStructuredAttention.bind(controller)
    })
    if (!reply.ok) {
      throw new Error(reply.error.message)
    }
    return reply.result
  })
  const state = useAppStore.getState()
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1' })] },
    unifiedTabsByWorktree: {
      [WORKSPACE]: [
        makeUnifiedTab({
          id: TAB,
          worktreeId: WORKSPACE,
          groupId: 'group',
          contentType: 'agent-session',
          entityId: SESSION,
          agentSessionAgent: 'claude'
        })
      ]
    },
    groupsByWorktree: {
      [WORKSPACE]: [
        makeTabGroup({ id: 'group', worktreeId: WORKSPACE, activeTabId: TAB, tabOrder: [TAB] })
      ]
    },
    activeGroupIdByWorktree: { [WORKSPACE]: 'group' },
    activeWorktreeId: WORKSPACE,
    activeView: 'terminal',
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironments: [],
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    manuallyUnreadTurnsByPaneKey: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    settings: { ...state.settings, experimentalTerminalAttention: true }
  })
})
afterEach(() => {
  cleanup()
  clearStructuredHostStub()
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionTurnCompletionFeedsForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('reads the first accepted history even after local unread and clock targets were cleared', async () => {
  addPrompt('A')
  render(
    <>
      <StructuredAgentSessionAttentionBridge />
      <AttentionPolicy />
      <ReadSurface viewed />
    </>
  )
  await waitFor(() => expect(hydrate).toBeTypeOf('function'))
  expect(readCalls()).toBe(0)
  expect(useAppStore.getState().unreadAgentCompletionPanes).toEqual({})
  await act(async () => hydrate?.())
  await waitFor(() =>
    expect(dismissIds()).toEqual([agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')])
  )
  expect(readCalls()).toBe(1)
})

it('reads B on return while A keeps the already-read row clock unchanged', async () => {
  useAppStore.setState({ activeWorktreeId: 'elsewhere' })
  useAppStore
    .getState()
    .setAgentStatus(
      SUBJECT,
      { state: 'blocked', prompt: 'Work', agentType: 'claude' },
      'Chat',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: TAB, worktreeId: WORKSPACE }
    )
  const screen = render(
    <>
      <StructuredAgentSessionAttentionBridge />
      <AttentionPolicy />
      <ReadSurface viewed={false} />
    </>
  )
  await waitFor(() => expect(completion).toBeTypeOf('function'))
  act(() => addPrompt('A'))
  await act(async () => hydrate?.())
  await waitFor(() => expect(journal).toBeTypeOf('function'))
  act(() => useAppStore.getState().acknowledgeAgents([SUBJECT]))
  await waitFor(() => expect(dismissIds()).toHaveLength(1))
  const stamp = useAppStore.getState().acknowledgedAgentsByPaneKey[SUBJECT]
  act(() => {
    addPrompt('B')
    publishView()
  })
  expect(dismissIds()).toHaveLength(1)
  expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBe('agent-completion')
  act(() => useAppStore.setState({ activeWorktreeId: WORKSPACE }))
  screen.rerender(
    <>
      <StructuredAgentSessionAttentionBridge />
      <AttentionPolicy />
      <ReadSurface viewed />
    </>
  )
  await waitFor(() =>
    expect(dismissIds()).toEqual(
      ['A', 'B'].map((id) => agentSessionPromptAttentionKey(SCOPE, SESSION, id))
    )
  )
  expect(useAppStore.getState().acknowledgedAgentsByPaneKey[SUBJECT]).toBe(stamp)
  expect(useAppStore.getState().unreadAgentCompletionPanes[SUBJECT]).toBeUndefined()
  expect(readCalls()).toBe(2)
})

it('reads a newly accepted visible prompt without sending an RPC for text-only updates', async () => {
  addPrompt('A')
  render(
    <>
      <StructuredAgentSessionAttentionBridge />
      <AttentionPolicy />
      <ReadSurface viewed />
    </>
  )
  await waitFor(() => expect(hydrate).toBeTypeOf('function'))
  await act(async () => hydrate?.())
  await waitFor(() => expect(readCalls()).toBe(1))
  act(() => {
    addPrompt('B')
    publishView()
  })
  await waitFor(() => expect(dismissIds()).toHaveLength(2))
  const calls = readCalls()
  act(() => {
    items = [
      ...items,
      {
        itemId: 'text',
        revision: 1,
        sequence: ++sequence,
        observedAt: sequence,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'More output' }]
        }
      }
    ]
    publishView()
  })
  await act(async () => {})
  expect(readCalls()).toBe(calls)
})

it('keeps hydration unread while away and retries the read on presence return', async () => {
  transport.away.mockResolvedValue(true)
  addPrompt('A')
  render(
    <>
      <StructuredAgentSessionAttentionBridge />
      <AttentionPolicy />
      <ReadSurface viewed />
    </>
  )
  await waitFor(() => expect(hydrate).toBeTypeOf('function'))
  await act(async () => hydrate?.())
  expect(readCalls()).toBe(0)
  transport.away.mockResolvedValue(false)
  await act(async () => window.dispatchEvent(new Event('focus')))
  await waitFor(() => expect(dismissIds()).toHaveLength(1))
})

it.each(['transport-error', 'false-result'] as const)(
  'retries a remote %s on a later read with the existing presence gate',
  async (failure) => {
    const target = { kind: 'environment', environmentId: 'retry-host' } as const
    const tab = useAppStore.getState().unifiedTabsByWorktree[WORKSPACE]?.[0]
    if (!tab) {
      throw new Error('chat tab missing')
    }
    useAppStore.setState({
      unifiedTabsByWorktree: { [WORKSPACE]: [{ ...tab, executionHostId: 'runtime:retry-host' }] }
    })
    addPrompt('A')
    const original = transport.call.getMockImplementation()
    let failed = false
    transport.call.mockImplementation(async (...args) => {
      if (args[1] === 'agentSession.acknowledgeAttention' && !failed) {
        failed = true
        if (failure === 'transport-error') {
          throw new Error('scripted transient transport failure')
        }
        return { acknowledged: false }
      }
      return original?.(...args)
    })
    render(
      <>
        <StructuredAgentSessionAttentionBridge />
        <AttentionPolicy />
        <ReadSurface viewed target={target} />
      </>
    )
    await waitFor(() => expect(hydrate).toBeTypeOf('function'))
    await act(async () => hydrate?.())
    expect(readCalls()).toBe(1)
    expect(dismissIds()).toEqual([])
    await act(async () => {})
    expect(readCalls()).toBe(1)
    if (failure === 'transport-error') {
      await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT]))
    } else {
      transport.away.mockResolvedValue(true)
      await act(async () => window.dispatchEvent(new Event('focus')))
      expect(readCalls()).toBe(1)
      transport.away.mockResolvedValue(false)
      await act(async () => window.dispatchEvent(new Event('focus')))
    }
    await waitFor(() =>
      expect(dismissIds()).toEqual([agentSessionPromptAttentionKey(SCOPE, SESSION, 'A')])
    )
    expect(readCalls()).toBe(2)
    expect(
      transport.call.mock.calls
        .filter(([, method]) => method === 'agentSession.acknowledgeAttention')
        .map(([owner]) => owner)
    ).toEqual([target, target])
  }
)

it('retries a failed local desktop relay withdrawal on a later explicit read', async () => {
  const relayDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-read-retry-'))
  try {
    addPrompt('A')
    const sent = events.find((event) => event.type === 'notification')
    if (!sent?.notificationId || sent.type !== 'notification') {
      throw new Error('prompt not sent')
    }
    const relay = new RuntimeMobileNotificationController()
    relay.configureDismissalStore(relayDirectory)
    relay.dispatch(sent)
    const withdrawals: string[] = []
    relay.onDispatched((event) => {
      if (event.type === 'dismiss') {
        withdrawals.push(event.notificationId)
      }
    })
    transport.dismiss
      .mockImplementation(async (_ids, _panes, reads?: StructuredNotificationRead[]) => {
        for (const read of reads ?? []) {
          relay.retireStructuredAttention(read)
        }
        return { dismissed: 0 }
      })
      .mockRejectedValueOnce(new Error('scripted local retirement failure'))
    render(
      <>
        <StructuredAgentSessionAttentionBridge />
        <AttentionPolicy />
        <ReadSurface viewed />
      </>
    )
    await waitFor(() => expect(hydrate).toBeTypeOf('function'))
    await act(async () => hydrate?.())
    expect(dismissIds()).toHaveLength(1)
    expect(withdrawals).toEqual([])
    await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT]))
    await waitFor(() => expect(withdrawals).toEqual([sent.notificationId]))
    expect(transport.dismiss.mock.calls.filter(([, , reads]) => Array.isArray(reads))).toHaveLength(
      2
    )
  } finally {
    rmSync(relayDirectory, { recursive: true, force: true })
  }
})

it('an older failed attempt cannot erase a newer success when the observation returns to A', async () => {
  addPrompt('A')
  const original = transport.call.getMockImplementation()
  let release: (() => void) | undefined
  let first = true
  transport.call.mockImplementation(async (...args) => {
    if (args[1] === 'agentSession.acknowledgeAttention' && first) {
      first = false
      return await new Promise((resolve) => {
        release = () => resolve({ acknowledged: false })
      })
    }
    return original?.(...args)
  })
  render(
    <>
      <StructuredAgentSessionAttentionBridge />
      <AttentionPolicy />
      <ReadSurface viewed />
    </>
  )
  await waitFor(() => expect(hydrate).toBeTypeOf('function'))
  await act(async () => hydrate?.())
  expect(readCalls()).toBe(1)
  act(() => useAppStore.getState().acknowledgeAgents([SUBJECT]))
  expect(readCalls()).toBe(1)
  act(() => {
    addPrompt('B')
    publishView()
  })
  await waitFor(() => expect(readCalls()).toBe(2))
  await act(async () => {})
  act(() => {
    items = items.map((item): AgentJournalRenderItem =>
      item.itemId === 'B' && item.body.kind === 'approval'
        ? {
            ...item,
            revision: item.revision + 1,
            body: { ...item.body, resolution: { ...item.body.resolution, state: 'resolved' } }
          }
        : item
    )
    sequence += 1
    hostFeed.observe(SESSION)
    publishView()
  })
  await waitFor(() => expect(readCalls()).toBe(3))
  await act(async () => release?.())
  await act(async () => useAppStore.getState().acknowledgeAgents([SUBJECT]))
  expect(readCalls()).toBe(3)
  expect(dismissIds()).toHaveLength(2)
})

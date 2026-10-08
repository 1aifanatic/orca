// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import type { AgentMessageSource } from '../../../../shared/agent-session-message-source'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import type { Tab } from '../../../../shared/tab-types'
import { NativeChatAgentMessageSenders } from './NativeChatAgentMessageSenders'

const feeds = vi.hoisted(
  () =>
    new Map<
      string,
      {
        snapshot: ReadonlyMap<string, AgentSessionStatusSummary>
        listeners: Set<() => void>
        live: boolean
        activations: number
      }
    >()
)
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: (target: { kind: string; environmentId?: string }) => {
    const feed = feeds.get(target.environmentId ?? 'local')!
    return {
      activate: () => {
        feed.activations++
        return () => {
          feed.activations--
        }
      },
      getSnapshot: () => feed.snapshot,
      getCapability: () => 'supported',
      getSessionObservation: () => (feed.live ? 'live' : 'unverifiable'),
      subscribe: (listener: () => void) => {
        feed.listeners.add(listener)
        return () => {
          feed.listeners.delete(listener)
        }
      }
    }
  }
}))
const openAgentMessageSender = vi.hoisted(() => vi.fn())
vi.mock('@/lib/open-agent-message-sender', () => ({ openAgentMessageSender }))

const ROOT = testOrcaSessionId('root-chat')
const RECIPIENT = 'recipient'
const SENDER = 'sender'
const PANE = 'terminal:11111111-1111-4111-8111-111111111111'
const initial = useAppStore.getInitialState()
const providerA = { key: 'session_id' as const, id: 'provider-a' }

function summary(sessionId: string, root: string | null = ROOT): AgentSessionStatusSummary {
  return {
    sessionId,
    workspaceId: SENDER,
    agent: 'claude',
    status: null,
    latestPrompt: '',
    updatedAt: 1,
    orchestrationSessionId: root
  }
}
function tab(sessionId: string, name: string, host: 'local' | 'runtime:remote' = 'local'): Tab {
  return {
    id: `tab-${host}-${sessionId}`,
    entityId: sessionId,
    worktreeId: SENDER,
    groupId: 'g',
    contentType: 'agent-session',
    executionHostId: host,
    label: 'Claude Chat',
    customLabel: name,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}
function source(terminal = false): AgentMessageSource {
  return {
    kind: 'agent',
    orchestration: null,
    senders: [
      {
        party: {
          address: terminal ? 'term-a' : `orca_session_id:${ROOT}`,
          terminalHandle: terminal ? 'term-a' : null,
          orcaSessionId: terminal ? null : ROOT
        },
        name: 'Original sender'
      }
    ]
  }
}
function publish(host: string, summaries: AgentSessionStatusSummary[]): void {
  const feed = feeds.get(host)!
  feed.snapshot = new Map(summaries.map((row) => [row.sessionId, row]))
  for (const listener of feed.listeners) {
    listener()
  }
}
function row(provider = providerA, agentType = 'claude'): AgentStatusEntry {
  return {
    paneKey: PANE,
    terminalHandle: 'term-a',
    worktreeId: SENDER,
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType,
    providerSession: provider,
    connectionId: null
  }
}

beforeEach(() => {
  openAgentMessageSender.mockClear()
  feeds.set('local', {
    snapshot: new Map([[ROOT, summary(ROOT)]]),
    listeners: new Set(),
    live: true,
    activations: 0
  })
  feeds.set('remote', { snapshot: new Map(), listeners: new Set(), live: true, activations: 0 })
  useAppStore.setState(
    { ...initial, activeWorktreeId: RECIPIENT, activeWorkspaceExecutionHostId: 'local' },
    true
  )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  feeds.clear()
})

it.each([false, true])(
  'updates the %s queued sender through multiple clears and ignores reopened history',
  (queued) => {
    useAppStore.setState({ unifiedTabsByWorktree: { [SENDER]: [tab(ROOT, 'Original sender')] } })
    render(
      <NativeChatAgentMessageSenders from={source()} chatWorktreeId={RECIPIENT} queued={queued} />
    )
    act(() => {
      publish('local', [summary(ROOT, null), summary('clear-one')])
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [SENDER]: [tab(ROOT, 'History'), tab('clear-one', 'First rename')]
        }
      })
    })
    expect(screen.getByRole('button', { name: 'First rename' })).toBeInTheDocument()
    act(() => {
      publish('local', [summary(ROOT, null), summary('clear-one', null), summary('clear-two')])
      useAppStore.setState({
        unifiedTabsByWorktree: {
          [SENDER]: [tab(ROOT, 'History'), tab('clear-two', 'Second rename')]
        }
      })
    })
    expect(screen.getByRole('button', { name: 'Second rename' })).toBeInTheDocument()
    act(() => useAppStore.setState({ unifiedTabsByWorktree: { [SENDER]: [tab(ROOT, 'History')] } }))
    expect(screen.getByRole('button', { name: 'Original sender' })).toBeInTheDocument()
  }
)

it('uses the recipient host when identical session text is published by two hosts', () => {
  publish('local', [summary('clear-shared')])
  publish('remote', [summary('clear-shared')])
  useAppStore.setState({
    activeWorkspaceExecutionHostId: 'runtime:remote',
    unifiedTabsByWorktree: {
      [SENDER]: [
        tab('clear-shared', 'Remote sender', 'runtime:remote'),
        tab('clear-shared', 'Wrong host')
      ]
    }
  })
  render(<NativeChatAgentMessageSenders from={source()} chatWorktreeId={RECIPIENT} />)
  expect(screen.getByRole('button', { name: 'Remote sender' })).toBeInTheDocument()
})

it('preserves direct-root rename behavior when an older host omits lineage identity', () => {
  const { orchestrationSessionId: _root, ...older } = summary(ROOT)
  publish('local', [older])
  useAppStore.setState({ unifiedTabsByWorktree: { [SENDER]: [tab(ROOT, 'Legacy root rename')] } })
  render(<NativeChatAgentMessageSenders from={source()} chatWorktreeId={RECIPIENT} />)
  expect(screen.getByRole('button', { name: 'Legacy root rename' })).toBeInTheDocument()
})

it.each([false, true])(
  'keeps CLI A saved name after provider B and a terminal rename reuse the shell (%s queued)',
  (queued) => {
    const terminal = {
      id: 'terminal',
      ptyId: 'pty',
      worktreeId: SENDER,
      title: 'Claude Code',
      customTitle: 'Resumed A',
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE]: row() },
      tabsByWorktree: { [SENDER]: [terminal] }
    })
    const from = source(true)
    render(<NativeChatAgentMessageSenders from={from} chatWorktreeId={RECIPIENT} queued={queued} />)
    expect(screen.getByRole('button', { name: 'Original sender' })).toBeInTheDocument()
    act(() => {
      useAppStore.setState({
        agentStatusByPaneKey: { [PANE]: row({ key: 'session_id', id: 'provider-b' }) },
        tabsByWorktree: { [SENDER]: [{ ...terminal, customTitle: 'Renamed B' }] }
      })
    })
    const link = screen.getByRole('button', { name: 'Original sender' })
    expect(link).toBeInTheDocument()
    fireEvent.click(link)
    expect(openAgentMessageSender).toHaveBeenCalledWith(from, from.senders[0], RECIPIENT)
    expect(feeds.get('local')!.activations).toBe(0)
  }
)

it('falls back during disconnect, resumes live names after reconnect, and releases shared feed readers', () => {
  useAppStore.setState({ unifiedTabsByWorktree: { [SENDER]: [tab(ROOT, 'Current sender')] } })
  const view = render(<NativeChatAgentMessageSenders from={source()} chatWorktreeId={RECIPIENT} />)
  const feed = feeds.get('local')!
  expect(screen.getByRole('button', { name: 'Current sender' })).toBeInTheDocument()
  expect(feed.activations).toBe(2)
  act(() => {
    feed.live = false
    publish('local', [summary(ROOT)])
  })
  expect(screen.getByRole('button', { name: 'Original sender' })).toBeInTheDocument()
  act(() => {
    feed.live = true
    publish('local', [summary(ROOT, null), summary('clear-new')])
    useAppStore.setState({
      unifiedTabsByWorktree: { [SENDER]: [tab('clear-new', 'Reconnected sender')] }
    })
  })
  expect(screen.getByRole('button', { name: 'Reconnected sender' })).toBeInTheDocument()
  view.unmount()
  expect(feed.activations).toBe(0)
  expect(feed.listeners.size).toBe(0)
})

it('keeps the recorded name when newer-host summaries disagree about the current root owner', () => {
  publish('local', [summary('clear-one'), summary('clear-two')])
  useAppStore.setState({ unifiedTabsByWorktree: { [SENDER]: [tab('clear-one', 'Wrong owner')] } })
  render(<NativeChatAgentMessageSenders from={source()} chatWorktreeId={RECIPIENT} />)
  expect(screen.getByRole('button', { name: 'Original sender' })).toBeInTheDocument()
})

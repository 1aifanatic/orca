// @vitest-environment happy-dom

// A Codex parent settles, its subagent asks for approval, and the user answers. Every hop is the
// real one: provider translator, deferred sink, durable journal and host status feed, then the
// renderer's status bridge, agent-status store and Activity pipeline. The ask is the subagent's,
// so the session's own status stays at its turn's end while the row waits on the user: from the
// session's `awaitsUserSince` alone, or with the child's own record waiting too, dated by the ask so
// a read ask stays read through later rows and a reload. Answering it returns the
// row to done, and nothing the user had already read comes back unread.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../src/shared/agent-session-wire'
import type { AgentJournalItemBody } from '../../src/shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../src/shared/agent-session-journal-item-key'
import type { Tab } from '../../src/shared/tab-types'
import type { AppState } from '../../src/renderer/src/store/types'
import { AgentHookServer } from '../../src/main/agent-hooks/server'
import { CodexBackgroundTaskTracker } from '../../src/main/codex/codex-background-task-tracker'
import { createCodexJournalTranslator } from '../../src/main/codex/codex-structured-journal-translation'
import { CODEX_COMMAND_APPROVAL_METHOD } from '../../src/main/codex/codex-structured-prompt-replies'
import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-event-sink'
import { StructuredAgentSessionStatusFeed } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-status-feed-test-session'
import {
  makeRepo,
  makeWorktree
} from '../../src/renderer/src/components/activity/ActivityPrototypePage-test-fixtures'
import {
  activityThreadRowCopy,
  activityThreadStatusId
} from '../../src/renderer/src/components/activity/activity-thread-presentation'
import { countActivityUnread } from '../../src/renderer/src/components/activity/useActivityUnreadCount'
import { useAgentPaneThreads } from '../../src/renderer/src/components/activity/use-agent-pane-threads'

type TestStore = {
  getState: () => AppState
  setState: (state: Partial<AppState> & { testRuntimeOwner?: string | null }) => void
}

const mocks = vi.hoisted(() => {
  const hoisted: { store: TestStore | null; subscribeStatus: Mock; unsubscribe: Mock } = {
    store: null,
    subscribeStatus: vi.fn(),
    unsubscribe: vi.fn()
  }
  return hoisted
})

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  const useAppStore = createTestStore()
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (state: { testRuntimeOwner?: string | null }) =>
    state.testRuntimeOwner ?? null
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSession: vi.fn(),
  subscribeStructuredAgentSessionStatus: mocks.subscribeStatus
}))

import { StructuredAgentSessionStatusBridge } from '../../src/renderer/src/components/native-chat/StructuredAgentSessionStatusBridge'
import { resetStructuredAgentSessionStatusFeedsForTests } from '../../src/renderer/src/runtime/structured-agent-session-status-feed'

const SESSION = 'codex-child-approval'
const CODEX_THREAD = 'thread-parent'
const CODEX_CHILD = 'thread-child'

const structuredTab = {
  id: 'structured-tab-1',
  worktreeId: 'wt-1',
  groupId: 'group-1',
  contentType: 'agent-session',
  entityId: SESSION,
  label: 'Codex Chat',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  isPinned: false,
  agentSessionAgent: 'codex'
} satisfies Tab

let root: string
const journals = createTrackedJournalOpener()

function store(): TestStore {
  if (!mocks.store) {
    throw new Error('store missing')
  }
  return mocks.store
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  mocks.subscribeStatus.mockResolvedValue({ unsubscribe: mocks.unsubscribe })
  root = await mkdtemp(join(tmpdir(), 'orca-codex-child-approval-'))
  const worktree = makeWorktree()
  store().setState({
    agentStatusByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    retainedAgentsByPaneKey: {},
    testRuntimeOwner: null,
    repos: [makeRepo()],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    unifiedTabsByWorktree: { 'wt-1': [structuredTab] }
  })
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  resetStructuredAgentSessionStatusFeedsForTests()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** The host half: journal, feed and the real Codex translator over one advancing clock. With
 *  `childRecords`, the real Codex child-work producer also feeds the host's child records. */
async function openHost(childRecords: boolean) {
  let clock = 10_000
  const tick = (): number => (clock += 1_000)
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'wt-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: CODEX_THREAD }
    },
    now: tick,
    stateDirectory: join(root, SESSION)
  })
  const statusStore = new AgentHookServer()
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([
      [SESSION, indexedStatusFeedSession({ journal, child: { phase: 'ready' } })]
    ]),
    getRecord: () => null,
    now: () => 1,
    // The host's own agent-status store, wired as the app wires it: it holds the child records.
    statusSink: () => ({
      publish: (summary, subject) => statusStore.ingestStructuredStatus(summary, subject),
      forget: (subject) => statusStore.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        statusStore.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => statusStore.getStructuredChildWorkViews(subject)
    })
  })
  const events: AgentSessionStatusEvent[] = []
  feed.subscribe({ id: 'renderer', emit: (event) => events.push(event) })
  const deferred = createDeferredStructuredAgentSessionEventSink()
  const publish = (): void => feed.publish(SESSION, journal)
  deferred.bind({ journal, fence: 1, publish })
  const prompts: string[] = []
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => CODEX_THREAD,
    now: tick,
    bindPromptItemId: (journalItemId) => prompts.push(journalItemId),
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const tracker = childRecords
    ? new CodexBackgroundTaskTracker(CODEX_THREAD, undefined, {
        deliver: (evidence) => feed.publishChildWork(SESSION, evidence),
        now: tick
      })
    : null
  const on = (threadId: string, method: string, params: Record<string, unknown> = {}) => {
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId,
      method,
      params: { threadId, ...params },
      observedAt: tick()
    })
    // As the adapter orders it: the journal has the frame before the host admits its evidence.
    tracker?.observe({ method, threadId, params: { threadId, ...params } })
    tracker?.publishChildWork()
  }
  const drain = async (): Promise<void> => {
    expect(await deferred.drained()).toEqual({ ok: true })
  }
  /** What the host's answer path commits before it tells Codex. */
  const answer = async (itemId: string): Promise<void> => {
    const identity = parseAgentJournalItemKey(itemId)
    const asked = journal.snapshot().items.find((item) => item.itemId === itemId)?.body
    if (!identity || asked?.kind !== 'approval') {
      throw new Error(`approval ${itemId} missing`)
    }
    const resolved: AgentJournalItemBody = {
      ...asked,
      resolution: {
        state: 'resolved',
        selectedOptionId: 'accept',
        resolvedBy: 'user',
        resolvedAt: tick()
      }
    }
    await journal.appendItem(identity, resolved, { fence: 1 })
    publish()
    translator.resolvePrompt(itemId)
  }
  return {
    journal,
    translator,
    on,
    drain,
    answer,
    prompts,
    events,
    tick,
    statusStore,
    close: deferred.close
  }
}

/** The parent settles, its subagent asks, and the renderer has every publication so far. */
async function untilAsked(childRecords: boolean) {
  const host = await openHost(childRecords)
  render(createElement(StructuredAgentSessionStatusBridge))
  await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledOnce())
  let forwarded = 0
  /** Forwards what the host published since the last call to the bridge mounted now. */
  const deliver = (): AgentSessionStatusSummary => {
    const toRenderer: (event: AgentSessionStatusEvent) => void =
      mocks.subscribeStatus.mock.calls.at(-1)?.[1]
    act(() => {
      for (const event of host.events.slice(forwarded)) {
        toRenderer(event)
      }
    })
    forwarded = host.events.length
    const latest = host.events.findLast((event) => event.type === 'status')
    if (latest?.type !== 'status') {
      throw new Error('status publication missing')
    }
    return latest.session
  }
  const paneKey = (): string => Object.keys(store().getState().agentStatusByPaneKey)[0] ?? ''

  await host.journal.appendItem(
    { provider: 'orca', clientMessageId: 'prompt-1' },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'fan out' }] },
    { fence: 1 }
  )
  host.on(CODEX_THREAD, 'turn/started', { turn: { id: 'parent-turn' } })
  const spawn = {
    type: 'subAgentActivity',
    id: 'spawn-child',
    kind: 'started',
    agentThreadId: CODEX_CHILD,
    agentPath: '/root/review'
  }
  host.on(CODEX_THREAD, 'item/started', { turnId: 'parent-turn', item: spawn })
  host.on(CODEX_THREAD, 'item/completed', { turnId: 'parent-turn', item: spawn })
  host.on(CODEX_CHILD, 'turn/started', { turn: { id: 'child-turn' } })
  host.on(CODEX_THREAD, 'turn/completed', { turn: { id: 'parent-turn', status: 'completed' } })
  await host.drain()
  const settled = deliver()
  expect(settled).toMatchObject({ status: 'idle', statusStartedAt: expect.any(Number) })
  store().setState({ acknowledgedAgentsByPaneKey: { [paneKey()]: host.tick() } })

  host.translator.handle({
    type: 'prompt',
    sessionId: SESSION,
    threadId: CODEX_CHILD,
    method: CODEX_COMMAND_APPROVAL_METHOD,
    params: { command: 'pnpm test', availableDecisions: ['accept', 'decline'] },
    codexItemId: 'child-exec',
    promptKey: 'child-approval'
  })
  if (childRecords) {
    host.on(CODEX_CHILD, 'thread/status/changed', {
      status: { type: 'active', activeFlags: ['waitingOnApproval'] }
    })
  }
  await host.drain()
  // The journal stamps the child's prompt with its thread, so it is not the session's own ask,
  // but someone in the session must answer it, since the ask.
  const asked = deliver()
  expect(asked).toMatchObject({
    status: 'idle',
    awaitsUserSince: expect.any(Number),
    statusStartedAt: settled.statusStartedAt
  })
  // Only the producer under test writes a child record; without it the session's fact is all.
  expect(asked.children?.map((child) => child.state) ?? []).toEqual(childRecords ? ['waiting'] : [])
  return { host, deliver, paneKey, settled, asked }
}

const CASES = [
  ['with no child record for it', false],
  ["with the child's own record waiting", true]
] as const

describe("a Codex subagent's answered approval on the settled parent's Activity row", () => {
  it.each(CASES)(
    'waits on the parent %s, then reads done and leaves the answer read',
    async (_label, childRecords) => {
      const { host, deliver, paneKey, settled, asked } = await untilAsked(childRecords)
      const waiting = threads()[0]
      expect(waiting && activityThreadStatusId(waiting)).toBe('waiting')
      expect(waiting && activityThreadRowCopy(waiting).needsAttention).toBe(true)
      // The host's own row, which `worktree ps`, mobile and the dashboard read, folds the same fact.
      expect(host.statusStore.getStatusSnapshot()).toEqual([
        expect.objectContaining({
          state: 'waiting',
          mainAgent: expect.objectContaining({ state: 'done' }),
          stateStartedAt: asked.awaitsUserSince
        })
      ])
      // The user reads the ask, then answers it.
      store().setState({ acknowledgedAgentsByPaneKey: { [paneKey()]: host.tick() } })
      const [approval] = host.prompts
      await host.answer(approval ?? '')
      if (childRecords) {
        host.on(CODEX_CHILD, 'thread/status/changed', {
          status: { type: 'active', activeFlags: [] }
        })
      }
      host.on(CODEX_CHILD, 'turn/completed', { turn: { id: 'child-turn', status: 'completed' } })
      await host.drain()
      const answered = deliver()
      // The host rule under test elsewhere: the answer never re-dates the session's done.
      expect(answered).toMatchObject({ status: 'idle', statusStartedAt: settled.statusStartedAt })
      expect(answered).not.toHaveProperty('awaitsUserSince')
      expect(answered.updatedAt).toBeGreaterThan(asked.updatedAt)

      const [row, ...others] = threads()
      expect(others).toHaveLength(0)
      if (!row) {
        throw new Error('activity thread missing')
      }
      expect(activityThreadStatusId(row)).toBe('done')
      expect(activityThreadRowCopy(row).needsAttention).toBe(false)
      expect(row.events.map((event) => event.state)).toEqual(['done', 'waiting', 'done'])
      expect(row.events.map((event) => event.unread)).toEqual([false, false, false])
      expect(countActivityUnread(store().getState())).toBe(0)
      host.translator.dispose()
      host.close()
    }
  )

  it.each(CASES)(
    'keeps a read ask read %s through a later row and a reload',
    async (_label, childRecords) => {
      const { host, deliver, paneKey, asked } = await untilAsked(childRecords)
      const pane = paneKey()
      // Dated by the ask itself, so nothing that lands after the user read it can re-date it.
      expect(store().getState().agentStatusByPaneKey[pane]?.stateStartedAt).toBe(
        asked.awaitsUserSince
      )
      const readAt = host.tick()
      store().setState({ acknowledgedAgentsByPaneKey: { [pane]: readAt } })
      host.on(CODEX_CHILD, 'item/completed', {
        turnId: 'child-turn',
        item: { type: 'agentMessage', id: 'child-note', text: 'still waiting' }
      })
      await host.drain()
      const later = deliver()
      expect(later.updatedAt).toBeGreaterThan(asked.updatedAt)
      expect(countActivityUnread(store().getState())).toBe(0)
      // A reload: a fresh bridge over an empty row store holding the persisted read marker.
      cleanup()
      resetStructuredAgentSessionStatusFeedsForTests()
      act(() =>
        store().setState({
          agentStatusByPaneKey: {},
          acknowledgedAgentsByPaneKey: { [pane]: readAt }
        })
      )
      render(createElement(StructuredAgentSessionStatusBridge))
      await waitFor(() => expect(mocks.subscribeStatus).toHaveBeenCalledTimes(2))
      const reloaded: (event: AgentSessionStatusEvent) => void =
        mocks.subscribeStatus.mock.calls[1]?.[1]
      act(() => reloaded({ type: 'snapshot', sessions: [later] }))
      expect(store().getState().agentStatusByPaneKey[pane]).toMatchObject({
        state: 'waiting',
        stateStartedAt: asked.awaitsUserSince
      })
      expect(countActivityUnread(store().getState())).toBe(0)
      host.translator.dispose()
      host.close()
    }
  )
})

function threads() {
  return renderHook(() =>
    useAgentPaneThreads({
      query: '',
      readFilter: 'all',
      groupBy: 'none',
      selectedPaneKey: null,
      showChildAgents: true
    })
  ).result.current.allThreads
}

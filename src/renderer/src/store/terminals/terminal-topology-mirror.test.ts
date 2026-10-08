import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createSessionWriteSubscriber } from '@/lib/session-write-subscriber'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  TerminalTopologySlice,
  TerminalTopologyTabRow
} from '../../../../shared/terminal-topology-slice'

const WT = 'repo::/wt'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

const initial = useAppStore.getState()

function windowTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WT,
    title: `Window ${id}`,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function unified(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group',
    worktreeId: WT,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  }
}

function leafLayout(leafId: string, ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId },
    buffersByLeafId: { [leafId]: 'scrollback' }
  }
}

function row(id: string, overrides: Partial<TerminalTopologyTabRow> = {}): TerminalTopologyTabRow {
  return { id, ptyId: `pty-${id}`, worktreeId: WT, createdAt: 1, ...overrides }
}

function slice(publishSeq: number, overrides: Partial<TerminalTopologySlice> = {}) {
  return {
    hostId: 'local',
    worktreeId: WT,
    publishSeq,
    revision: 1,
    tabs: [row('a'), row('b')],
    presentation: {},
    layouts: {
      a: { root: { type: 'leaf', leafId: LEAF_A }, ptyIdsByLeafId: { [LEAF_A]: 'pty-a' } },
      b: { root: { type: 'leaf', leafId: LEAF_B }, ptyIdsByLeafId: { [LEAF_B]: 'pty-b' } }
    },
    sleeping: {},
    ...overrides
  } satisfies TerminalTopologySlice
}

const group: TabGroup = { id: 'group', worktreeId: WT, activeTabId: 'a', tabOrder: ['a', 'b'] }

function seed(): void {
  useAppStore.setState({
    tabsByWorktree: {
      [WT]: [
        windowTab('a', {
          customTitle: 'Mine',
          color: '#f00',
          isPinned: true,
          generation: 3,
          pendingActivationSpawn: 2,
          agentLaunchPane: { leafId: LEAF_A, operationId: 'op' }
        }),
        windowTab('b', { sortOrder: 1 })
      ]
    },
    terminalLayoutsByTabId: { a: leafLayout(LEAF_A, 'pty-a'), b: leafLayout(LEAF_B, 'pty-b') },
    ptyIdsByTabId: { a: ['pty-a'], b: ['pty-b'] },
    unifiedTabsByWorktree: {
      [WT]: [
        unified('a'),
        unified('b', { sortOrder: 1 }),
        unified('/wt/readme.md', { contentType: 'editor' })
      ]
    },
    groupsByWorktree: { [WT]: [{ ...group, tabOrder: ['a', 'b', '/wt/readme.md'] }] },
    activeGroupIdByWorktree: { [WT]: 'group' }
  })
  useAppStore.getState().applyTerminalTopologySlices([slice(1)])
}

const apply = (next: TerminalTopologySlice) =>
  useAppStore.getState().applyTerminalTopologySlices([next])
const state = () => useAppStore.getState()

afterEach(() => {
  vi.useRealTimers()
  useAppStore.setState(initial, true)
})

describe('applyTerminalTopologySlices', () => {
  beforeEach(seed)

  it('keeps presentation, liveness and activation state while replacing topology', () => {
    const ptyIdsByTabId = state().ptyIdsByTabId
    apply(
      slice(2, {
        tabs: [row('a', { ptyId: 'pty-main', launchAgent: 'codex' }), row('b')],
        layouts: {
          ...slice(2).layouts,
          a: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: LEAF_A },
              second: { type: 'leaf', leafId: LEAF_C }
            },
            ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_C]: 'pty-c' },
            titlesByLeafId: { [LEAF_C]: 'logs' }
          }
        }
      })
    )

    const tab = state().tabsByWorktree[WT][0]
    expect(tab).toMatchObject({
      launchAgent: 'codex',
      customTitle: 'Mine',
      color: '#f00',
      isPinned: true,
      generation: 3,
      pendingActivationSpawn: 2,
      agentLaunchPane: { leafId: LEAF_A, operationId: 'op' },
      // The row's ptyId is the window's live attachment, not main's last binding.
      ptyId: 'pty-a'
    })
    expect(state().terminalLayoutsByTabId.a).toEqual({
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_C }
      },
      activeLeafId: LEAF_A,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_C]: 'pty-c' },
      titlesByLeafId: { [LEAF_C]: 'logs' },
      buffersByLeafId: { [LEAF_A]: 'scrollback' }
    })
    expect(state().ptyIdsByTabId).toBe(ptyIdsByTabId)
  })

  it('clears an optional row field main dropped', () => {
    apply(slice(2, { tabs: [row('a', { launchAgent: 'codex' }), row('b')] }))
    apply(slice(3))
    expect(state().tabsByWorktree[WT][0]).not.toHaveProperty('launchAgent')
  })

  it('leaves the store untouched by an identical slice and schedules no save', () => {
    vi.useFakeTimers()
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    const persist = vi.fn()
    const dispose = createSessionWriteSubscriber({ store: useAppStore, persist })
    vi.advanceTimersByTime(1_000)
    persist.mockClear()
    const before = state()

    apply(slice(2))

    for (const key of [
      'tabsByWorktree',
      'terminalLayoutsByTabId',
      'unifiedTabsByWorktree',
      'groupsByWorktree',
      'sleepingAgentSessionsByPaneKey',
      'ptyIdsByTabId'
    ] as const) {
      expect(state()[key]).toBe(before[key])
    }
    vi.advanceTimersByTime(1_000)
    expect(persist).not.toHaveBeenCalled()
    dispose()
  })

  it('never echoes a changed slice back as a session save', () => {
    vi.useFakeTimers()
    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    const persist = vi.fn()
    const dispose = createSessionWriteSubscriber({ store: useAppStore, persist })
    vi.advanceTimersByTime(1_000)
    persist.mockClear()

    apply(slice(2, { tabs: [row('a')], layouts: { a: slice(2).layouts.a } }))
    vi.advanceTimersByTime(1_000)
    expect(persist).not.toHaveBeenCalled()

    // A later local edit still saves.
    state().setTabCustomTitle('a', 'renamed')
    vi.advanceTimersByTime(1_000)
    expect(persist).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('keeps every other tab and layout reference when one tab changes', () => {
    const before = state()
    apply(
      slice(2, {
        layouts: {
          ...slice(2).layouts,
          b: { root: { type: 'leaf', leafId: LEAF_B }, ptyIdsByLeafId: { [LEAF_B]: 'pty-b2' } }
        }
      })
    )
    expect(state().terminalLayoutsByTabId.a).toBe(before.terminalLayoutsByTabId.a)
    expect(state().terminalLayoutsByTabId.b.ptyIdsByLeafId).toEqual({ [LEAF_B]: 'pty-b2' })
    expect(state().tabsByWorktree).toBe(before.tabsByWorktree)
  })

  it('removes a tab and its unified entry joined on entityId, leaving other tabs alone', () => {
    useAppStore.setState({
      unifiedTabsByWorktree: {
        [WT]: [
          unified('a'),
          unified('unified-b', { entityId: 'b' }),
          unified('/wt/readme.md', { contentType: 'editor' })
        ]
      },
      groupsByWorktree: {
        [WT]: [
          {
            ...group,
            activeTabId: 'unified-b',
            tabOrder: ['a', 'unified-b', '/wt/readme.md'],
            recentTabIds: ['a', 'unified-b']
          }
        ]
      }
    })

    apply(slice(2, { tabs: [row('a')], layouts: { a: slice(2).layouts.a } }))

    expect(state().tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a'])
    expect(state().terminalLayoutsByTabId).not.toHaveProperty('b')
    expect(state().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a', '/wt/readme.md'])
    expect(state().groupsByWorktree[WT][0]).toMatchObject({
      tabOrder: ['a', '/wt/readme.md'],
      activeTabId: 'a',
      recentTabIds: ['a']
    })
  })

  it('appends a new tab to the active group without activating it', () => {
    apply(
      slice(2, {
        tabs: [...slice(2).tabs, row('c', { defaultTitle: 'Terminal 3', launchAgent: 'claude' })],
        layouts: {
          ...slice(2).layouts,
          c: { root: { type: 'leaf', leafId: LEAF_C }, ptyIdsByLeafId: { [LEAF_C]: 'pty-c' } }
        }
      })
    )

    expect(state().tabsByWorktree[WT][2]).toEqual({
      id: 'c',
      ptyId: 'pty-c',
      worktreeId: WT,
      createdAt: 1,
      defaultTitle: 'Terminal 3',
      launchAgent: 'claude',
      title: 'Terminal 3',
      customTitle: null,
      color: null,
      sortOrder: 2
    })
    expect(state().terminalLayoutsByTabId.c).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_C },
      activeLeafId: LEAF_C
    })
    expect(state().unifiedTabsByWorktree[WT].at(-1)).toMatchObject({
      id: 'c',
      entityId: 'c',
      groupId: 'group',
      contentType: 'terminal'
    })
    expect(state().groupsByWorktree[WT][0]).toMatchObject({
      activeTabId: 'a',
      tabOrder: ['a', 'b', '/wt/readme.md', 'c']
    })
    expect(state().ptyIdsByTabId).not.toHaveProperty('c')
  })

  it("shows main's saved title and colour on a tab main created, and keeps the window's on its own", () => {
    state().setTabCustomTitle('a', 'renamed here')
    apply(
      slice(2, {
        tabs: [...slice(2).tabs, row('c', { defaultTitle: 'Terminal 3' })],
        presentation: {
          a: { customTitle: 'stale in main', color: 'blue' },
          c: { customTitle: 'cli-made', color: 'red' }
        }
      })
    )

    expect(
      state().tabsByWorktree[WT].map(({ id, customTitle, color }) => [id, customTitle, color])
    ).toEqual([
      ['a', 'renamed here', '#f00'],
      ['b', null, null],
      ['c', 'cli-made', 'red']
    ])
  })

  it('does not add a unified entry a tab already has under another id', () => {
    useAppStore.setState({
      unifiedTabsByWorktree: {
        [WT]: [unified('a'), unified('b'), unified('u-c', { entityId: 'c' })]
      }
    })
    apply(slice(2, { tabs: [...slice(2).tabs, row('c')] }))
    expect(state().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a', 'b', 'u-c'])
  })

  it('leaves a runtime-hosted tab under the same worktree id untouched', () => {
    const runtimeTab = windowTab('remote-tab', { ptyId: 'remote:env@@handle' })
    useAppStore.setState({
      tabsByWorktree: { [WT]: [...state().tabsByWorktree[WT], runtimeTab] },
      unifiedTabsByWorktree: {
        [WT]: [
          ...state().unifiedTabsByWorktree[WT],
          unified('remote-tab', { executionHostId: 'runtime:env' })
        ]
      }
    })
    apply(slice(2, { tabs: [row('a')], layouts: { a: slice(2).layouts.a } }))
    expect(state().tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a', 'remote-tab'])
    expect(state().tabsByWorktree[WT][1]).toBe(runtimeTab)
    expect(state().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toContain('remote-tab')
  })

  it('replaces only this worktree’s sleeping records', () => {
    const record = (paneKey: string, worktreeId: string): SleepingAgentSessionRecord => ({
      paneKey,
      worktreeId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: paneKey },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1
    })
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        [`a:${LEAF_A}`]: record(`a:${LEAF_A}`, WT),
        'other:leaf': record('other:leaf', 'repo::/other')
      }
    })
    apply(slice(2, { sleeping: { [`b:${LEAF_B}`]: record(`b:${LEAF_B}`, WT) } }))
    expect(Object.keys(state().sleepingAgentSessionsByPaneKey).sort()).toEqual([
      `b:${LEAF_B}`,
      'other:leaf'
    ])
  })

  it("reads the window's sleeping records a fixed number of times per batch, however many worktrees", () => {
    const enumerationsFor = (worktreeCount: number): number => {
      let enumerations = 0
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: new Proxy<Record<string, SleepingAgentSessionRecord>>(
          {},
          {
            ownKeys: (target) => {
              enumerations += 1
              return Reflect.ownKeys(target)
            }
          }
        )
      })
      const worktreeIds = Array.from(
        { length: worktreeCount },
        (_, index) => `repo::/wt-${worktreeCount}-${index}`
      )
      state().applyTerminalTopologySlices(
        worktreeIds.map((worktreeId) =>
          slice(10, { worktreeId, tabs: [row(`t-${worktreeId}`, { worktreeId })], layouts: {} })
        )
      )
      return enumerations
    }

    const single = enumerationsFor(1)
    expect(single).toBeGreaterThan(0)
    expect(enumerationsFor(50)).toBe(single)
  })

  it('restores main’s slice at the applied seq over this window’s refused change', () => {
    apply(slice(3))
    useAppStore.setState({
      tabsByWorktree: { [WT]: [...state().tabsByWorktree[WT], windowTab('refused')] }
    })

    state().restoreTerminalTopologySlice(slice(2))
    expect(state().tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a', 'b', 'refused'])
    state().restoreTerminalTopologySlice(slice(3))
    expect(state().tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a', 'b'])
  })

  it('ignores a slice older than the last one applied', () => {
    apply(slice(5, { tabs: [row('a')], layouts: { a: slice(5).layouts.a } }))
    const before = state()
    apply(slice(4))
    expect(state()).toBe(before)
    expect(state().tabsByWorktree[WT].map((tab) => tab.id)).toEqual(['a'])
  })

  it('leaves other worktrees and non-terminal tabs untouched', () => {
    const other = windowTab('x', { worktreeId: 'repo::/other' })
    useAppStore.setState({
      tabsByWorktree: { ...state().tabsByWorktree, 'repo::/other': [other] }
    })
    apply(slice(2, { tabs: [], layouts: {} }))
    expect(state().tabsByWorktree['repo::/other'][0]).toBe(other)
    expect(state().tabsByWorktree[WT]).toEqual([])
    expect(state().unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual(['/wt/readme.md'])
  })
})

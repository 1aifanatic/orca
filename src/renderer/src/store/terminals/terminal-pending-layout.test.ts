import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TerminalLayoutSetResult } from '../../../../shared/terminal-layout-set'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import type { TerminalTopologySlice } from '../../../../shared/terminal-topology-slice'
import { commitPendingTerminalChange, withPendingTerminalPane } from './terminal-pending-panes'

const WT = 'repo::/wt'
const TAB = 'tab'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode,
  ratio?: number
): TerminalPaneLayoutNode => ({
  type: 'split',
  direction: 'vertical',
  first,
  second,
  ...(ratio !== undefined ? { ratio } : {})
})
const BEFORE = split(leaf(A), leaf(B))
const DRAGGED = split(leaf(A), leaf(B), 0.3)

type Reply = TerminalLayoutSetResult & { publishSeq?: number }

const initial = useAppStore.getState()
const originalWindow = globalThis.window
let replies: { resolve: (reply: Reply) => void; reject: (error: Error) => void }[] = []
const setTerminalLayout = vi.fn(
  (_request: unknown) =>
    new Promise<Reply>((resolve, reject) => {
      replies.push({ resolve, reject })
    })
)

function slice(publishSeq: number, root: TerminalPaneLayoutNode): TerminalTopologySlice {
  return {
    hostId: 'local',
    worktreeId: WT,
    publishSeq,
    revision: 1,
    tabs: [{ id: TAB, ptyId: 'pty-a', worktreeId: WT, createdAt: 1 }],
    layouts: { [TAB]: { root, ptyIdsByLeafId: { [A]: 'pty-a', [B]: 'pty-b' } } },
    sleeping: {}
  }
}

const state = () => useAppStore.getState()
const rootInStore = () => state().terminalLayoutsByTabId[TAB]?.root
const apply = (publishSeq: number, root: TerminalPaneLayoutNode) =>
  state().applyTerminalTopologySlice(slice(publishSeq, root))
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What the drag end does: the window takes its own tree, then commits it to main. */
function dragEnd(root: TerminalPaneLayoutNode): void {
  const layout = state().terminalLayoutsByTabId[TAB]
  state().setTabLayout(TAB, { ...layout!, root })
  commitPendingTerminalChange(state(), { worktreeId: WT, tabId: TAB, change: 'layout', root }, () =>
    setTerminalLayout({ worktreeId: WT, tabId: TAB, root })
  )
}

beforeEach(() => {
  replies = []
  setTerminalLayout.mockClear()
  vi.stubGlobal('window', { api: { session: { setTerminalLayout } } })
  useAppStore.setState({
    tabsByWorktree: {
      [WT]: [
        {
          id: TAB,
          ptyId: 'pty-a',
          worktreeId: WT,
          title: 'T',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  })
  apply(1, BEFORE)
})

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.window = originalWindow
  useAppStore.setState(initial, true)
})

describe('a divider drag committed to main', () => {
  it('sends the tree once, and a mirror apply never sends one', () => {
    apply(2, split(leaf(A), leaf(B), 0.6))
    expect(setTerminalLayout).not.toHaveBeenCalled()

    dragEnd(DRAGGED)

    expect(setTerminalLayout).toHaveBeenCalledExactlyOnceWith({
      worktreeId: WT,
      tabId: TAB,
      root: DRAGGED
    })
  })

  it('is not snapped back by an older push, before or after the reply', async () => {
    dragEnd(DRAGGED)
    const kept = state().terminalLayoutsByTabId[TAB]

    apply(2, BEFORE)
    expect(rootInStore()).toEqual(DRAGGED)
    expect(state().terminalLayoutsByTabId[TAB]).toBe(kept)

    replies[0]!.resolve({ status: 'committed', publishSeq: 4 })
    await flush()
    apply(3, BEFORE)
    expect(rootInStore()).toEqual(DRAGGED)

    apply(4, DRAGGED)
    // Settled: a later host edit (another client's drag) applies.
    apply(5, split(leaf(A), leaf(B), 0.8))
    expect(rootInStore()).toEqual(split(leaf(A), leaf(B), 0.8))
  })

  it('settles on the reply when main published it first', async () => {
    dragEnd(DRAGGED)
    apply(2, DRAGGED)
    replies[0]!.resolve({ status: 'committed', publishSeq: 2 })
    await flush()
    expect(state().pendingTerminalPanes).toEqual([])

    apply(3, BEFORE)
    expect(rootInStore()).toEqual(BEFORE)
  })

  it("yields at once to main's tree when main's tab has other panes", () => {
    dragEnd(DRAGGED)
    const closed = split(leaf(A), leaf(C))
    apply(2, closed)
    expect(rootInStore()).toEqual(closed)
    expect(state().pendingTerminalPanes).toEqual([])
  })

  it('keeps the latest of two drags when the first reply lands', async () => {
    dragEnd(DRAGGED)
    const second = split(leaf(A), leaf(B), 0.2)
    dragEnd(second)
    replies[0]!.resolve({ status: 'committed', publishSeq: 2 })
    await flush()

    apply(2, DRAGGED)
    expect(rootInStore()).toEqual(second)
  })

  it('stops holding the tree when main could not be reached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    dragEnd(DRAGGED)
    replies[0]!.reject(new Error('gone'))
    await flush()

    apply(2, BEFORE)
    expect(rootInStore()).toEqual(BEFORE)
  })

  it("leaves the tab's pending add in place; only a later drag replaces a drag", () => {
    const add = { worktreeId: WT, tabId: TAB, change: 'add' } as const
    const first = { worktreeId: WT, tabId: TAB, change: 'layout', root: DRAGGED } as const
    const second = { ...first, root: BEFORE }
    expect(withPendingTerminalPane(withPendingTerminalPane([add], first), second)).toEqual([
      add,
      second
    ])
  })
})

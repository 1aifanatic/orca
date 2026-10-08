import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type {
  TerminalTopologyReply,
  TerminalTopologySlice
} from '../../../../shared/terminal-topology-slice'
import { commitTerminalSurfaceClose } from './terminal-surface-close-intent'
import {
  commitTerminalPaneIfAheadOfMain,
  pendingTerminalLeafIds,
  terminalTabPanesNamed
} from './terminal-pending-panes'
import { makeWorktree } from '../slices/store-test-helpers'

const WT = 'repo::/wt'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const initial = useAppStore.getState()
const state = () => useAppStore.getState()
const apply = (next: TerminalTopologySlice) => state().applyTerminalTopologySlice(next)
const tabIds = () => (state().tabsByWorktree[WT] ?? []).map((tab) => tab.id)
const unifiedIds = () => (state().unifiedTabsByWorktree[WT] ?? []).map((tab) => tab.entityId)

function slice(publishSeq: number, tabs: Record<string, string[]>): TerminalTopologySlice {
  const leaf = (leafId: string) => ({ type: 'leaf' as const, leafId })
  return {
    hostId: 'local',
    worktreeId: WT,
    publishSeq,
    revision: 1,
    tabs: Object.keys(tabs).map((id) => ({ id, ptyId: null, worktreeId: WT, createdAt: 1 })),
    presentation: {},
    layouts: Object.fromEntries(
      Object.entries(tabs).map(([id, [first, second]]) => [
        id,
        {
          root: second
            ? {
                type: 'split' as const,
                direction: 'vertical' as const,
                first: leaf(first),
                second: leaf(second)
              }
            : leaf(first)
        }
      ])
    ),
    sleeping: {}
  }
}

/** Main's replies are released by the test, so either order can be driven. */
function stubReplies(method: 'closeTerminalSurface' | 'createTerminalSurface'): {
  reply: (answer: TerminalTopologyReply | Error) => void
  calls: ReturnType<typeof vi.fn>
} {
  const pending: ((answer: TerminalTopologyReply | Error) => void)[] = []
  const calls = vi.fn(
    () =>
      new Promise<TerminalTopologyReply>((resolve, reject) => {
        pending.push((answer) => (answer instanceof Error ? reject(answer) : resolve(answer)))
      })
  )
  vi.stubGlobal('window', { api: { session: { [method]: calls } } })
  return { reply: (answer) => pending.shift()?.(answer), calls }
}

const stubCloseReplies = () => {
  const { reply, calls } = stubReplies('closeTerminalSurface')
  return { reply, closeTerminalSurface: calls }
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  apply(slice(1, { a: [LEAF_A] }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

describe('a tab this window creates', () => {
  it('survives a push that does not yet contain it, and settles once main names it', () => {
    const tab = state().createTab(WT)

    apply(slice(2, { a: [LEAF_A, LEAF_B] }))
    expect(tabIds()).toEqual(['a', tab.id])
    expect(state().pendingTerminalPanes).toHaveLength(1)

    apply(slice(3, { a: [LEAF_A, LEAF_B], [tab.id]: [LEAF_B] }))
    expect(tabIds()).toEqual(['a', tab.id])
    expect(state().pendingTerminalPanes).toEqual([])

    // Main owns it now, so main dropping it removes it here.
    apply(slice(4, { a: [LEAF_A] }))
    expect(tabIds()).toEqual(['a'])
  })

  it('is committed to main as a new tab, and settles by the reply even if main never names it', async () => {
    const main = stubReplies('createTerminalSurface')
    const tab = state().createTab(WT)
    expect(main.calls).toHaveBeenCalledWith({
      worktreeId: WT,
      tabId: tab.id,
      placement: { kind: 'new-tab', row: expect.objectContaining({ title: tab.title }) }
    })

    // Main refused it (say, closed elsewhere): the push holding the reply drops it here.
    main.reply({ publishSeq: 2 })
    await settled()
    apply(slice(2, { a: [LEAF_A] }))
    expect(tabIds()).toEqual(['a'])
    expect(state().pendingTerminalPanes).toEqual([])
  })

  it('keeps a pane main has not named yet, and only that one', () => {
    state().markPendingTerminalPane({ worktreeId: WT, tabId: 'a', leafId: LEAF_B, change: 'add' })
    expect(pendingTerminalLeafIds(state().pendingTerminalPanes, 'a', 'add')).toEqual(
      new Set([LEAF_B])
    )
    apply(slice(2, { a: [LEAF_A, LEAF_B] }))
    expect(state().pendingTerminalPanes).toEqual([])
  })
})

describe('a worktree a paired Orca server hosts', () => {
  // Main publishes no slice for it, so nothing would ever settle an entry held here.
  it('holds no pending entry for a tab or pane made here', () => {
    useAppStore.setState({
      worktreesByRepo: {
        repo: [makeWorktree({ id: WT, repoId: 'repo', hostId: 'runtime:env-1' })]
      }
    })
    const create = stubReplies('createTerminalSurface')
    const tab = state().createTab(WT)
    commitTerminalPaneIfAheadOfMain(state(), {
      worktreeId: WT,
      tabId: tab.id,
      leafId: LEAF_B,
      placement: { kind: 'new-tab' }
    })

    expect(create.calls).not.toHaveBeenCalled()

    expect(state().pendingTerminalPanes).toEqual([])
  })
})

describe('a tab this window closes', () => {
  it.each([
    ['the reply', true],
    ['the push', false]
  ])('is not brought back by an older push when %s comes first', async (_, replyFirst) => {
    apply(slice(10, { a: [LEAF_A], b: [LEAF_B] }))
    const main = stubCloseReplies()
    state().closeTab('b')
    expect(main.closeTerminalSurface).toHaveBeenCalledOnce()

    // A push main sent before it closed the tab still names it.
    apply(slice(11, { a: [LEAF_A], b: [LEAF_B] }))
    expect(tabIds()).toEqual(['a'])
    expect(unifiedIds()).toEqual(['a'])

    if (replyFirst) {
      main.reply({ publishSeq: 12 })
      await settled()
      apply(slice(12, { a: [LEAF_A] }))
    } else {
      apply(slice(12, { a: [LEAF_A] }))
      main.reply({ publishSeq: 12 })
      await settled()
    }
    expect(tabIds()).toEqual(['a'])
    expect(state().pendingTerminalPanes).toEqual([])
  })

  it('shows main’s copy again when main refuses the close', async () => {
    apply(slice(10, { a: [LEAF_A], b: [LEAF_B] }))
    const main = stubCloseReplies()
    state().closeTab('b')
    main.reply(new Error('write failed'))
    await settled()
    expect(state().pendingTerminalPanes).toEqual([])

    apply(slice(11, { a: [LEAF_A], b: [LEAF_B] }))
    expect(tabIds()).toEqual(['a', 'b'])
  })
})

describe('a pane this window closes', () => {
  it('stays hidden until main’s push holding the close is applied', async () => {
    const main = stubCloseReplies()
    commitTerminalSurfaceClose(state(), WT, { kind: 'pane', tabId: 'a', leafId: LEAF_B })
    expect(pendingTerminalLeafIds(state().pendingTerminalPanes, 'a', 'remove')).toEqual(
      new Set([LEAF_B])
    )
    main.reply({ publishSeq: 3 })
    await settled()
    apply(slice(2, { a: [LEAF_A, LEAF_B] }))
    expect(pendingTerminalLeafIds(state().pendingTerminalPanes, 'a', 'remove').size).toBe(1)

    apply(slice(3, { a: [LEAF_A] }))
    expect(state().pendingTerminalPanes).toEqual([])
  })
})

describe('a split pane this window creates', () => {
  const split = {
    worktreeId: WT,
    tabId: 'a',
    leafId: LEAF_B,
    placement: { kind: 'split' as const, parentLeafId: LEAF_A, direction: 'vertical' as const }
  }

  it('is committed to main before any spawn, and settles by the reply', async () => {
    const main = stubReplies('createTerminalSurface')
    commitTerminalPaneIfAheadOfMain(state(), split)
    expect(main.calls).toHaveBeenCalledWith(split)
    expect(pendingTerminalLeafIds(state().pendingTerminalPanes, 'a', 'add')).toEqual(
      new Set([LEAF_B])
    )
    main.reply({ publishSeq: 2 })
    await settled()
    apply(slice(2, { a: [LEAF_A, LEAF_B] }))
    expect(state().pendingTerminalPanes).toEqual([])
  })

  // A pane whose process never starts used to hold its tab's layout sends, and their listener, forever.
  it('never starting does not hold its tab’s layout sends or leak a store listener', async () => {
    const main = stubReplies('createTerminalSurface')
    let listeners = 0
    const subscribe = (listener: () => void): (() => void) => {
      listeners += 1
      const unsubscribe = useAppStore.subscribe(listener)
      return () => {
        listeners -= 1
        unsubscribe()
      }
    }
    commitTerminalPaneIfAheadOfMain(state(), split)
    let sent = false
    void terminalTabPanesNamed(subscribe, state, 'a').then(() => (sent = true))
    await settled()
    expect(sent).toBe(false)
    expect(listeners).toBe(1)

    // Settled by the reply's push alone, whether or not main named the pane.
    main.reply({ publishSeq: 2 })
    await settled()
    apply(slice(2, { a: [LEAF_A] }))
    await settled()
    expect(sent).toBe(true)
    expect(listeners).toBe(0)
  })
})

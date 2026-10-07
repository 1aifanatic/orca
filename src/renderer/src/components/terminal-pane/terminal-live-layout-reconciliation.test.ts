import { describe, expect, it } from 'vitest'
import {
  planTerminalLiveLayoutInsertions,
  planTerminalLiveLayoutRemovals,
  selectRetiredPaneIds,
  trackRetiredLeafIds
} from './terminal-live-layout-reconciliation'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'

describe('planTerminalLiveLayoutInsertions', () => {
  it('plans a host-added split leaf from an already-mounted source leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-b',
        direction: 'vertical',
        placement: 'after'
      }
    ])
  })

  it('plans nested missing leaves in the order splitPane can apply them', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-b',
        direction: 'vertical',
        placement: 'after'
      },
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-b'],
        newLeafId: 'leaf-c',
        direction: 'horizontal',
        placement: 'after'
      }
    ])
  })

  it('bridges a missing parent second subtree before filling the first subtree', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-b' }
      },
      second: { type: 'leaf', leafId: 'leaf-c' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a'])).toEqual([
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-c',
        direction: 'vertical',
        placement: 'after'
      },
      {
        sourceLeafId: 'leaf-a',
        sourceLeafIds: ['leaf-a'],
        newLeafId: 'leaf-b',
        direction: 'horizontal',
        placement: 'after'
      }
    ])
  })

  it('plans a parent sibling after an already-mounted first-side split with host ratio', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.35,
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-b' }
      },
      second: { type: 'leaf', leafId: 'leaf-c' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-a', 'leaf-b'])).toEqual([
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-a', 'leaf-b'],
        newLeafId: 'leaf-c',
        direction: 'vertical',
        placement: 'after',
        ratio: 0.35
      }
    ])
  })

  it('plans a missing first subtree before an already-mounted second leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-b'])).toEqual([
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-b'],
        newLeafId: 'leaf-a',
        direction: 'vertical',
        placement: 'before'
      }
    ])
  })

  it('plans nested missing first subtrees from an anchor in the second subtree', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-c'])).toEqual([
      {
        sourceLeafId: 'leaf-c',
        sourceLeafIds: ['leaf-c'],
        newLeafId: 'leaf-a',
        direction: 'vertical',
        placement: 'before'
      },
      {
        sourceLeafId: 'leaf-c',
        sourceLeafIds: ['leaf-c'],
        newLeafId: 'leaf-b',
        direction: 'horizontal',
        placement: 'before'
      }
    ])
  })

  it('plans a parent sibling before an already-mounted second-side split with host ratio', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.25,
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    }

    expect(planTerminalLiveLayoutInsertions(layout, ['leaf-b', 'leaf-c'])).toEqual([
      {
        sourceLeafId: 'leaf-b',
        sourceLeafIds: ['leaf-b', 'leaf-c'],
        newLeafId: 'leaf-a',
        direction: 'vertical',
        placement: 'before',
        ratio: 0.25
      }
    ])
  })

  it('does not plan insertions when the layout has no mounted anchor leaf', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutInsertions(layout, [])).toEqual([])
  })
})

describe('planTerminalLiveLayoutRemovals', () => {
  // Every mounted leaf counted as retired: the layout alone must veto removals.
  const BOTH = new Set(['leaf-a', 'leaf-b'])

  it('plans the mounted leaf a host-retired layout no longer names', () => {
    // Why: closing one pane of a remote-server split kills its PTY on the host,
    // which retires the leaf and republishes a one-leaf layout; the pane mounted
    // for the retired leaf must go too, or it lingers as a blank ghost.
    const layout: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-a' }

    expect(
      planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-b'], new Set(['leaf-b']))
    ).toEqual(['leaf-b'])
  })

  it('plans nothing when every mounted leaf is still in the layout', () => {
    const layout: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    }

    expect(planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-b'], BOTH)).toEqual([])
    expect(planTerminalLiveLayoutRemovals(layout, ['leaf-a'], BOTH)).toEqual([])
  })

  it('plans nothing for an empty layout', () => {
    expect(planTerminalLiveLayoutRemovals(null, ['leaf-a'], BOTH)).toEqual([])
    expect(planTerminalLiveLayoutRemovals(undefined, ['leaf-a'], BOTH)).toEqual([])
  })

  it('leaves a mounted leaf the host has never named alone', () => {
    // Why: a pane the client just split is still spawning, so its transport has
    // no PTY yet, and a host snapshot that lands mid-spawn does not name it.
    // Only a leaf the host named before can be one the host retired.
    const layout: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-a' }

    expect(
      planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-new'], new Set(['leaf-a']))
    ).toEqual([])
    expect(planTerminalLiveLayoutRemovals(layout, ['leaf-a', 'leaf-new'], new Set())).toEqual([])
  })
})

describe('selectRetiredPaneIds', () => {
  const view = (startingPaneIds: number[] = []) => ({
    paneIdForLeaf: (leafId: string) => (leafId === 'leaf-b' ? 2 : leafId === 'leaf-c' ? 3 : null),
    isPaneStarting: (paneId: number) => startingPaneIds.includes(paneId)
  })

  it('detaches a retired pane whether or not it still holds its PTY', () => {
    // Why: detaching never kills, so a live PTY main moved elsewhere needs no wait.
    expect(selectRetiredPaneIds(['leaf-b', 'leaf-c'], view())).toEqual([2, 3])
  })

  it('keeps a pane that is still starting its PTY', () => {
    // Main has not bound it yet, so a layout without it says nothing about it.
    expect(selectRetiredPaneIds(['leaf-b', 'leaf-c'], view([2]))).toEqual([3])
  })

  it('skips a leaf that has no mounted pane', () => {
    expect(selectRetiredPaneIds(['leaf-x'], view())).toEqual([])
  })
})

describe('trackRetiredLeafIds', () => {
  it('retires a mounted leaf the host dropped from its layout', () => {
    expect(
      trackRetiredLeafIds({
        retiredLeafIds: new Set(),
        previousLayoutLeafIds: new Set(['leaf-a', 'leaf-b']),
        layoutLeafIds: new Set(['leaf-a']),
        mountedLeafIds: ['leaf-a', 'leaf-b']
      })
    ).toEqual(new Set(['leaf-b']))
  })

  it('keeps a retired leaf until its pane is gone', () => {
    // Why: the removal may have been skipped while the transport still held its
    // PTY; the next reconciliation must still see the leaf as retired.
    const args = {
      retiredLeafIds: new Set(['leaf-b']),
      previousLayoutLeafIds: new Set(['leaf-a']),
      layoutLeafIds: new Set(['leaf-a'])
    }
    expect(trackRetiredLeafIds({ ...args, mountedLeafIds: ['leaf-a', 'leaf-b'] })).toEqual(
      new Set(['leaf-b'])
    )
    expect(trackRetiredLeafIds({ ...args, mountedLeafIds: ['leaf-a'] })).toEqual(new Set())
  })

  it('forgets a retired leaf the host names again', () => {
    expect(
      trackRetiredLeafIds({
        retiredLeafIds: new Set(['leaf-b']),
        previousLayoutLeafIds: new Set(['leaf-a']),
        layoutLeafIds: new Set(['leaf-a', 'leaf-b']),
        mountedLeafIds: ['leaf-a', 'leaf-b']
      })
    ).toEqual(new Set())
  })

  it('never retires a leaf the host has not named', () => {
    expect(
      trackRetiredLeafIds({
        retiredLeafIds: new Set(),
        previousLayoutLeafIds: new Set(['leaf-a']),
        layoutLeafIds: new Set(['leaf-a']),
        mountedLeafIds: ['leaf-a', 'leaf-new']
      })
    ).toEqual(new Set())
  })
})

describe('a retirement that lands while the pane is still starting', () => {
  it('detaches the pane on a later reconciliation once it has started', () => {
    const layout: TerminalPaneLayoutNode = { type: 'leaf', leafId: 'leaf-a' }
    const mounted = ['leaf-a', 'leaf-b']
    const paneIdForLeaf = (leafId: string) =>
      leafId === 'leaf-a' ? 1 : leafId === 'leaf-b' ? 2 : null

    let retired = trackRetiredLeafIds({
      retiredLeafIds: new Set(),
      previousLayoutLeafIds: new Set(mounted),
      layoutLeafIds: new Set(['leaf-a']),
      mountedLeafIds: mounted
    })
    let removals = planTerminalLiveLayoutRemovals(layout, mounted, retired)
    expect(removals).toEqual(['leaf-b'])
    expect(
      selectRetiredPaneIds(removals, { paneIdForLeaf, isPaneStarting: (paneId) => paneId === 2 })
    ).toEqual([])

    retired = trackRetiredLeafIds({
      retiredLeafIds: retired,
      previousLayoutLeafIds: new Set(['leaf-a']),
      layoutLeafIds: new Set(['leaf-a']),
      mountedLeafIds: mounted
    })
    removals = planTerminalLiveLayoutRemovals(layout, mounted, retired)
    expect(selectRetiredPaneIds(removals, { paneIdForLeaf, isPaneStarting: () => false })).toEqual([
      2
    ])
  })
})

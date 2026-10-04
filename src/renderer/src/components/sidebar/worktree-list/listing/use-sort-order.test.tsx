// @vitest-environment happy-dom

import { StrictMode, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import type { SortBy } from '../../smart-sort'
import { useSidebarWorktreeSortOrder } from './use-sort-order'

const initialState = useAppStore.getInitialState()
const repo = makeRepo()
const repoMap = new Map([[repo.id, repo]])

function seed(worktrees: Worktree[], sortBy: SortBy): void {
  useAppStore.setState({ sortBy, sortEpoch: 0, worktreesByRepo: { [repo.id]: worktrees } })
}

function bumpSortEpoch(): void {
  useAppStore.setState((s) => ({ sortEpoch: s.sortEpoch + 1 }))
}

function replaceWorktrees(worktrees: Worktree[]): void {
  useAppStore.setState((s) => ({
    worktreesByRepo: { [repo.id]: worktrees },
    sortEpoch: s.sortEpoch + 1
  }))
}

function renderSortOrder(sortBy: SortBy, options?: { strict?: boolean }) {
  const renders = { count: 0 }
  const hook = renderHook(
    ({ mode }: { mode: SortBy }) => {
      renders.count += 1
      const allWorktrees = Object.values(useAppStore((s) => s.worktreesByRepo)).flat()
      return useSidebarWorktreeSortOrder({ allWorktrees, repoMap, sortBy: mode })
    },
    { initialProps: { mode: sortBy }, wrapper: options?.strict ? StrictMode : undefined }
  )
  return { ...hook, renders }
}

describe('useSidebarWorktreeSortOrder', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('renders once per sortEpoch bump in Manual (no hook-initiated re-render)', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const { renders } = renderSortOrder('manual')
    const before = renders.count
    for (let i = 0; i < 10; i++) {
      act(() => bumpSortEpoch())
    }
    expect(renders.count - before).toBe(10)
  })

  it('applies a Manual reorder in the same commit as the bump', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const { result } = renderSortOrder('manual', { strict: true })
    expect(result.current).toEqual(['a', 'b'])
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'A', { manualOrder: 2 }),
        makeWorktree('b', 'B', { manualOrder: 3 })
      ])
    )
    expect(result.current).toEqual(['b', 'a'])
  })

  it('survives a burst of synchronous store bumps in Manual', () => {
    seed(
      [makeWorktree('a', 'A', { manualOrder: 2 }), makeWorktree('b', 'B', { manualOrder: 1 })],
      'manual'
    )
    const errors: unknown[] = []
    const previousActEnvironment = Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', false)
    const container = document.createElement('div')
    const root = createRoot(container, {
      onUncaughtError: (error) => errors.push(error),
      onCaughtError: (error) => errors.push(error)
    })
    function Probe(): null {
      const allWorktrees = Object.values(useAppStore((s) => s.worktreesByRepo)).flat()
      useSidebarWorktreeSortOrder({ allWorktrees, repoMap, sortBy: 'manual' })
      return null
    }
    try {
      flushSync(() => root.render(createElement(Probe)))
      for (let i = 0; i < 80; i++) {
        flushSync(() => bumpSortEpoch())
      }
      expect(errors).toEqual([])
    } finally {
      root.unmount()
      Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', previousActEnvironment)
    }
  })

  it('debounces Recent re-sorts until the settle window passes', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 1_000 })
      ],
      'recent'
    )
    const { result } = renderSortOrder('recent')
    expect(result.current).toEqual(['a', 'b'])
    act(() =>
      replaceWorktrees([
        makeWorktree('a', 'A', { lastActivityAt: 2_000 }),
        makeWorktree('b', 'B', { lastActivityAt: 3_000 })
      ])
    )
    expect(result.current).toEqual(['a', 'b'])
    act(() => vi.advanceTimersByTime(3_000))
    expect(result.current).toEqual(['b', 'a'])
  })

  it('applies an added worktree immediately in debounced modes', () => {
    vi.useFakeTimers()
    seed([makeWorktree('a', 'A')], 'name')
    const { result } = renderSortOrder('name')
    act(() => replaceWorktrees([makeWorktree('a', 'A'), makeWorktree('0', '0 first')]))
    expect(result.current).toEqual(['0', 'a'])
  })

  it('re-sorts on Manual -> Recent and stays put at settle', () => {
    vi.useFakeTimers()
    seed(
      [
        makeWorktree('a', 'A', { manualOrder: 2, lastActivityAt: 1_000 }),
        makeWorktree('b', 'B', { manualOrder: 1, lastActivityAt: 2_000 })
      ],
      'manual'
    )
    const { result, rerender } = renderSortOrder('manual')
    for (let i = 0; i < 5; i++) {
      act(() => bumpSortEpoch())
    }
    expect(result.current).toEqual(['a', 'b'])
    act(() => rerender({ mode: 'recent' }))
    expect(result.current).toEqual(['b', 'a'])
    const afterSwitch = result.current
    act(() => vi.advanceTimersByTime(3_000))
    expect(result.current).toBe(afterSwitch)
  })
})

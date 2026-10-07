import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseTerminalPanePlacement,
  type TerminalPanePlacement
} from '../../../shared/terminal-pane-placement'
import type { TerminalPaneLayoutNode, TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { applyPtyBinding } from '../loading-store/pty-binding-session-update'
import type { PersistPtyBindingArgs } from '../loading-store/pty-binding-persistence'

const WORKTREE = 'repo::/fixture'
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const NEW = '44444444-4444-4444-8444-444444444444'
const NOW = 1_800_000_000_000

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (
  direction: 'horizontal' | 'vertical',
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode,
  ratio?: number
): TerminalPaneLayoutNode => ({
  type: 'split',
  direction,
  first,
  second,
  ...(ratio !== undefined ? { ratio } : {})
})

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function session(root?: TerminalPaneLayoutNode | null): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: root === undefined ? {} : { [WORKTREE]: [tab('tab')] },
    terminalLayoutsByTabId:
      root === undefined
        ? {}
        : { tab: { root, activeLeafId: null, expandedLeafId: null, ptyIdsByLeafId: {} } }
  }
}

function bind(
  start: WorkspaceSessionState,
  placement?: TerminalPanePlacement,
  extra: Partial<PersistPtyBindingArgs> = {}
): WorkspaceSessionState {
  const next = structuredClone(start)
  const args: PersistPtyBindingArgs = {
    worktreeId: WORKTREE,
    tabId: 'tab',
    leafId: NEW,
    ptyId: 'pty-new',
    startupCwd: '/fixture/sub',
    ...extra,
    ...(placement ? { placement } : {})
  }
  applyPtyBinding(args, next, WORKTREE, `tab:${NEW}`)
  return next
}

const rootOf = (state: WorkspaceSessionState): TerminalPaneLayoutNode | null | undefined =>
  state.terminalLayoutsByTabId.tab?.root

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('new-tab placement', () => {
  it('builds the row from the minted row plus only the fields placement carries', () => {
    const minted = bind(session())
    const row = {
      title: 'build',
      defaultTitle: 'Terminal 3',
      customTitle: 'Build',
      color: '#f97316',
      createdAt: 7,
      startupCwd: '/fixture/build',
      shellOverride: 'zsh',
      quickCommandLabel: 'pnpm dev',
      launchAgent: 'claude' as const,
      viewMode: 'chat' as const
    }
    const placed = bind(session(), { kind: 'new-tab', row })
    expect(placed.tabsByWorktree[WORKTREE]).toEqual([
      { ...minted.tabsByWorktree[WORKTREE]?.[0], ...row }
    ])
    expect(placed.tabsByWorktree[WORKTREE]?.[0]?.pendingActivationSpawn).toBe(true)
    const { tabsByWorktree: _placedTabs, ...placedRest } = placed
    const { tabsByWorktree: _mintedTabs, ...mintedRest } = minted
    expect(placedRest).toEqual(mintedRest)
  })

  it('keeps a minted field the row leaves undefined', () => {
    const placed = bind(session(), {
      kind: 'new-tab',
      row: { title: 'build', customTitle: undefined }
    })
    expect(placed.tabsByWorktree[WORKTREE]?.[0]).toMatchObject({
      title: 'build',
      customTitle: null
    })
  })

  it("takes startupCwd only from the row, never from the spawn's cwd", () => {
    const placed = bind(session(), { kind: 'new-tab', row: { title: 'build' } })
    expect(placed.tabsByWorktree[WORKTREE]?.[0]).not.toHaveProperty('startupCwd')
    const withCwd = bind(session(), { kind: 'new-tab', row: { startupCwd: '/fixture/build' } })
    expect(withCwd.tabsByWorktree[WORKTREE]?.[0]?.startupCwd).toBe('/fixture/build')
    expect(bind(session()).tabsByWorktree[WORKTREE]?.[0]?.startupCwd).toBe('/fixture/sub')
  })

  it('is ignored when the tab already exists, and for a leaf already present', () => {
    const row = { title: 'other', color: '#000000' }
    const existing = session(leaf(A))
    expect(bind(existing, { kind: 'new-tab', row })).toEqual(bind(existing))
    const present = session(leaf(NEW))
    expect(bind(present, { kind: 'new-tab', row })).toEqual(bind(present))
  })

  it('without a row writes the minted tab', () => {
    expect(bind(session(), { kind: 'new-tab' })).toEqual(bind(session()))
  })
})

describe('split placement', () => {
  it('inserts at the parent leaf with direction and ratio', () => {
    const start = session(split('vertical', leaf(A), leaf(B)))
    const placed = bind(start, {
      kind: 'split',
      parentLeafId: B,
      direction: 'horizontal',
      ratio: 0.3
    })
    expect(rootOf(placed)).toEqual(
      split('vertical', leaf(A), split('horizontal', leaf(B), leaf(NEW), 0.3))
    )
    expect(placed.terminalLayoutsByTabId.tab).toMatchObject({
      activeLeafId: NEW,
      ptyIdsByLeafId: { [NEW]: 'pty-new' }
    })
  })

  it('keeps a nested before-split proposed tree verbatim', () => {
    const start = session(split('vertical', split('horizontal', leaf(A), leaf(B), 0.4), leaf(C)))
    const proposedRoot = split(
      'vertical',
      split('horizontal', leaf(A), split('vertical', leaf(NEW), leaf(B)), 0.4),
      leaf(C),
      0.6
    )
    const placed = bind(start, {
      kind: 'split',
      parentLeafId: B,
      direction: 'vertical',
      proposedRoot
    })
    expect(rootOf(placed)).toEqual(proposedRoot)
  })

  it('keeps a proposed tree that splits a subtree', () => {
    const start = session(split('vertical', leaf(A), leaf(B)))
    const proposedRoot = split('horizontal', split('vertical', leaf(A), leaf(B)), leaf(NEW))
    expect(
      rootOf(bind(start, { kind: 'split', parentLeafId: B, direction: 'horizontal', proposedRoot }))
    ).toEqual(proposedRoot)
  })

  it.each([
    ['misses a current leaf', split('vertical', leaf(A), leaf(NEW))],
    ['lacks the new leaf', split('vertical', leaf(A), leaf(B))],
    [
      'adds a foreign leaf',
      split('vertical', split('vertical', leaf(A), leaf(B)), split('vertical', leaf(NEW), leaf(C)))
    ],
    [
      'repeats a leaf',
      split('vertical', split('vertical', leaf(A), leaf(B)), split('vertical', leaf(NEW), leaf(A)))
    ]
  ])('falls back to the parent split when the proposed tree %s', (_name, proposedRoot) => {
    const start = session(split('vertical', leaf(A), leaf(B)))
    const placed = bind(start, {
      kind: 'split',
      parentLeafId: A,
      direction: 'horizontal',
      proposedRoot
    })
    expect(rootOf(placed)).toEqual(
      split('vertical', split('horizontal', leaf(A), leaf(NEW)), leaf(B))
    )
  })

  it('keeps today’s root graft when the parent is not in the tab', () => {
    const start = session(split('vertical', leaf(A), leaf(B)))
    const proposedRoot = split('vertical', leaf(NEW), split('vertical', leaf(A), leaf(B)))
    expect(
      bind(start, { kind: 'split', parentLeafId: C, direction: 'horizontal', proposedRoot })
    ).toEqual(bind(start))
    expect(rootOf(bind(start))).toEqual(
      split('vertical', split('vertical', leaf(A), leaf(B)), leaf(NEW))
    )
  })

  it('keeps today’s mint when the tab does not exist', () => {
    expect(bind(session(), { kind: 'split', parentLeafId: A, direction: 'horizontal' })).toEqual(
      bind(session())
    )
  })

  it('is ignored for a leaf already present', () => {
    const start = session(split('vertical', leaf(A), leaf(NEW)))
    const proposedRoot = split('horizontal', leaf(NEW), leaf(A))
    expect(
      bind(start, { kind: 'split', parentLeafId: A, direction: 'horizontal', proposedRoot })
    ).toEqual(bind(start))
  })

  it('bumps the topology revision exactly as the graft does', () => {
    const start = { ...session(leaf(A)), terminalTopologyRevisionByRepoId: { repo: 2 } }
    const placed = bind(start, { kind: 'split', parentLeafId: A, direction: 'horizontal' })
    expect(placed.terminalTopologyRevisionByRepoId).toEqual(
      bind(start).terminalTopologyRevisionByRepoId
    )
  })
})

describe('root and malformed placement', () => {
  it('root placement writes what an empty layout gets today', () => {
    const empty = session(null)
    expect(bind(empty, { kind: 'root' })).toEqual(bind(empty))
    expect(rootOf(bind(empty, { kind: 'root' }))).toEqual(leaf(NEW))
    const occupied = session(leaf(A))
    expect(bind(occupied, { kind: 'root' })).toEqual(bind(occupied))
  })

  it.each([
    { kind: 'split', parentLeafId: 'not-a-leaf', direction: 'vertical' },
    { kind: 'split', parentLeafId: A, direction: 'diagonal' },
    { kind: 'teleport' },
    'new-tab'
  ])('a malformed placement parses to none and writes today’s state: %j', (raw) => {
    const placement = parseTerminalPanePlacement(raw) ?? undefined
    expect(placement).toBeUndefined()
    const start = session(leaf(A))
    expect(bind(start, placement)).toEqual(bind(start))
  })

  it('drops only a malformed proposed tree, then splits at the parent', () => {
    const placement = parseTerminalPanePlacement({
      kind: 'split',
      parentLeafId: A,
      direction: 'horizontal',
      proposedRoot: { type: 'split', first: leaf(A) }
    })
    expect(rootOf(bind(session(leaf(A)), placement ?? undefined))).toEqual(
      split('horizontal', leaf(A), leaf(NEW))
    )
  })
})

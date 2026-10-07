import { describe, expect, it } from 'vitest'
import { getDefaultUIState } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { setLayout } from './terminal-topology-commit'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

const WT = 'repo::/wt'
const TAB = 'tab-1'
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

function session(root: TerminalPaneLayoutNode): WorkspaceSessionState {
  return {
    activeRepoId: 'repo',
    activeWorktreeId: WT,
    activeTabId: TAB,
    tabsByWorktree: {
      [WT]: [
        {
          id: TAB,
          ptyId: 'pty-a',
          worktreeId: WT,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root,
        activeLeafId: A,
        expandedLeafId: null,
        ptyIdsByLeafId: { [A]: 'pty-a', [B]: 'pty-b' }
      }
    }
  }
}

function profile(partitions: [ExecutionHostId, WorkspaceSessionState][]) {
  const state: Parameters<typeof setLayout>[1]['state'] = {
    workspaceSession: session(leaf(C)),
    workspaceSessionsByHostId: {},
    ui: getDefaultUIState(),
    sshRemotePtyLeases: []
  }
  const dirty = new Set<string>()
  const getSession = (hostId: ExecutionHostId): WorkspaceSessionState =>
    (hostId === 'local' ? state.workspaceSession : state.workspaceSessionsByHostId?.[hostId]) ??
    session(leaf(C))
  const context: Parameters<typeof setLayout>[1] = {
    state,
    hostIds: () => partitions.map(([hostId]) => hostId),
    getSession,
    markDirty: (domain) => dirty.add(domain)
  }
  for (const [hostId, value] of partitions) {
    assignWorkspaceSessionPartition(state, hostId, value)
  }
  const rootOf = (hostId: ExecutionHostId) => getSession(hostId).terminalLayoutsByTabId?.[TAB]?.root
  return { state, dirty, context, rootOf }
}

describe('setLayout', () => {
  it('commits a same-pane tree and keeps everything else in the layout', () => {
    const { context, dirty, rootOf, state } = profile([['local', session(split(leaf(A), leaf(B)))]])
    const dragged = split(leaf(A), leaf(B), 0.3)

    const result = setLayout({ worktreeId: WT, tabId: TAB, root: dragged }, context)()

    expect(result.value).toEqual({ status: 'committed' })
    expect(result.persist).not.toBe(false)
    expect(rootOf('local')).toEqual(dragged)
    expect(state.workspaceSession.terminalLayoutsByTabId?.[TAB]?.ptyIdsByLeafId).toEqual({
      [A]: 'pty-a',
      [B]: 'pty-b'
    })
    expect([...dirty]).toEqual(['workspaceSession'])
  })

  it('takes a reordered tree, which keeps the same panes', () => {
    const { context, rootOf } = profile([['local', session(split(leaf(A), leaf(B)))]])
    const swapped = split(leaf(B), leaf(A))
    expect(setLayout({ worktreeId: WT, tabId: TAB, root: swapped }, context)().value).toEqual({
      status: 'committed'
    })
    expect(rootOf('local')).toEqual(swapped)
  })

  it.each([
    ['an extra pane', split(split(leaf(A), leaf(B)), leaf(C))],
    ['a missing pane', leaf(A)],
    ['another pane in place of one', split(leaf(A), leaf(C))],
    ['a pane twice', split(split(leaf(A), leaf(B)), leaf(B))]
  ])('refuses a tree with %s and writes nothing', (_name, root) => {
    const before = split(leaf(A), leaf(B))
    const { context, dirty, rootOf } = profile([['local', session(before)]])

    const result = setLayout({ worktreeId: WT, tabId: TAB, root }, context)()

    expect(result.value).toEqual({ status: 'refused', reason: 'leaves_differ' })
    expect(result.persist).toBe(false)
    expect(rootOf('local')).toEqual(before)
    expect(dirty.size).toBe(0)
  })

  it('refuses a tab main does not hold', () => {
    const { context } = profile([['local', session(split(leaf(A), leaf(B)))]])
    const result = setLayout({ worktreeId: WT, tabId: 'other', root: leaf(A) }, context)()
    expect(result.value).toEqual({ status: 'refused', reason: 'tab_not_held' })
  })

  it('writes nothing for the tree main already holds', () => {
    const root = split(leaf(A), leaf(B), 0.4)
    const { context, dirty } = profile([['local', session(root)]])
    const result = setLayout({ worktreeId: WT, tabId: TAB, root: structuredClone(root) }, context)()
    expect(result).toEqual({ value: { status: 'committed' }, persist: false })
    expect(dirty.size).toBe(0)
  })

  it('updates every owner partition holding the tab, never a runtime: mirror', () => {
    const before = split(leaf(A), leaf(B))
    const { context, rootOf } = profile([
      ['local', session(before)],
      ['ssh:target', session(before)],
      ['runtime:env', session(before)]
    ])
    const dragged = split(leaf(A), leaf(B), 0.7)

    setLayout({ worktreeId: WT, tabId: TAB, root: dragged }, context)()

    expect(rootOf('local')).toEqual(dragged)
    expect(rootOf('ssh:target')).toEqual(dragged)
    expect(rootOf('runtime:env')).toEqual(before)
  })

  it('rolls back to the prior tree', () => {
    const before = split(leaf(A), leaf(B))
    const { context, rootOf } = profile([['local', session(before)]])
    const result = setLayout(
      { worktreeId: WT, tabId: TAB, root: split(leaf(A), leaf(B), 0.2) },
      context
    )()
    result.rollback?.()
    expect(rootOf('local')).toEqual(before)
  })
})

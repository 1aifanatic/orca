import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import type { TerminalSurfaceCloseCommit } from '../../runtime/terminal-surface-close'
import { closeLeafOrTab, importPeerTopology } from './terminal-topology-commit'

// An ssh: partition, so a leaked host id or worktree path would show in the span.
const HOST_ID: ExecutionHostId = 'ssh:target-1'
const WORKTREE_ID = 'ssh-repo::/srv/app'
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const SPLIT_TAB = 'tab-split'
const PINNED_TAB = 'tab-pinned'
const CLOSED_TAB = 'tab-closed-earlier'
const NOW = 1_700_000_000_000

function tab(id: string, ptyId: string, isPinned = false) {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...(isPinned ? { isPinned } : {})
  }
}

function session(): WorkspaceSessionState {
  return {
    activeRepoId: 'ssh-repo',
    activeWorktreeId: WORKTREE_ID,
    activeTabId: SPLIT_TAB,
    tabsByWorktree: { [WORKTREE_ID]: [tab(SPLIT_TAB, 'pty-1'), tab(PINNED_TAB, 'pty-3', true)] },
    terminalLayoutsByTabId: {
      [SPLIT_TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
      }
    },
    closedTerminalTabTombstonesByTabId: {
      [CLOSED_TAB]: { closedAt: NOW - 1000, worktreeId: WORKTREE_ID, reason: 'user' }
    },
    terminalTopologyRevisionByRepoId: { 'ssh-repo': 3 }
  }
}

function commitFor(
  target: TerminalSurfaceCloseTarget,
  overrides: Partial<TerminalSurfaceCloseCommit> = {}
): TerminalSurfaceCloseCommit {
  let current = session()
  return {
    worktreeId: WORKTREE_ID,
    target,
    options: {},
    requestedSession: current,
    ownerMatches: () => true,
    hostId: () => HOST_ID,
    getSession: () => current,
    setSession: (next) => {
      current = next
    },
    onClosed: () => {},
    ...overrides
  }
}

describe('persistence.terminal-topology span', () => {
  let records: { name: string; attributes: Record<string, unknown>; exit: unknown }[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    records = []
    setActiveSink({
      push: (record) => {
        records.push(JSON.parse(JSON.stringify(record)))
      },
      flush: () => {},
      close: () => {}
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    _resetTracerForTests()
  })

  function attributesAfter(commit: TerminalSurfaceCloseCommit): Record<string, unknown> {
    closeLeafOrTab(commit)()
    expect(records).toHaveLength(1)
    expect(records[0].name).toBe('persistence.terminal-topology')
    return records[0].attributes
  }

  it('records a committed pane close without ids', () => {
    expect(attributesAfter(commitFor({ kind: 'pane', tabId: SPLIT_TAB, leafId: LEAF_2 }))).toEqual({
      kind: 'persistence',
      'topology.kind': 'close_leaf',
      'topology.outcome': 'committed'
    })
    expect(JSON.stringify(records[0])).not.toMatch(/pty-|tab-split|ssh-repo|srv|target-1/)
  })

  it('records a committed tab close', () => {
    expect(attributesAfter(commitFor({ kind: 'tab', tabId: SPLIT_TAB }))).toMatchObject({
      'topology.kind': 'close_tab',
      'topology.outcome': 'committed'
    })
  })

  it('records a refusal with its reason code', () => {
    expect(attributesAfter(commitFor({ kind: 'tab', tabId: PINNED_TAB }))).toMatchObject({
      'topology.kind': 'close_tab',
      'topology.outcome': 'refused',
      'topology.refusal': 'terminal_tab_pinned'
    })
  })

  it('records a close that changes nothing as a noop', () => {
    const echo = commitFor({ kind: 'tab', tabId: CLOSED_TAB }, { options: { allowMissing: true } })
    expect(attributesAfter(echo)).toMatchObject({ 'topology.outcome': 'noop' })
  })

  it('records a thrown commit as a failed span and rethrows', () => {
    const mutation = closeLeafOrTab(
      commitFor(
        { kind: 'tab', tabId: SPLIT_TAB },
        {
          getSession: () => {
            throw new Error('read failed')
          }
        }
      )
    )
    expect(mutation).toThrow('read failed')
    expect(records).toHaveLength(1)
    expect(records[0].attributes).toMatchObject({ 'topology.outcome': 'threw' })
    expect(records[0].exit).toMatchObject({ _tag: 'Failure' })
  })

  it("commits an SSH import into that target's partition alone", () => {
    const patchWorkspaceSession = vi.fn()
    const unfenced = { ...session(), terminalTopologyRevisionByRepoId: {} }
    const store = { getWorkspaceSession: () => unfenced, patchWorkspaceSession }
    importPeerTopology(store, 'target-1', { tabsByWorktree: {} }, () => false)
    importPeerTopology(store, 'target-1', {}, () => false)

    expect(patchWorkspaceSession.mock.calls).toEqual([[{ tabsByWorktree: {} }, HOST_ID]])
    expect(records.map((record) => record.attributes)).toEqual([
      {
        kind: 'persistence',
        'topology.kind': 'import_peer_topology',
        'topology.outcome': 'committed'
      },
      { kind: 'persistence', 'topology.kind': 'import_peer_topology', 'topology.outcome': 'noop' }
    ])
  })
})

describe('an SSH import against a mirror main has published past', () => {
  const NEW_TAB = 'tab-created-by-cli'
  const HOST_TAB = 'tab-from-peer'

  // What main committed after the window read its mirror: a CLI-created tab, and the split's
  // second pane bound to its PTY.
  function mainAfterWindowRead(): WorkspaceSessionState {
    const prior = session()
    return {
      ...prior,
      tabsByWorktree: {
        [WORKTREE_ID]: [...prior.tabsByWorktree[WORKTREE_ID], tab(NEW_TAB, 'pty-new')]
      },
      terminalLayoutsByTabId: {
        ...prior.terminalLayoutsByTabId,
        [SPLIT_TAB]: {
          ...prior.terminalLayoutsByTabId[SPLIT_TAB],
          ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2-bound-late' }
        }
      }
    }
  }

  // The window's merge of the host snapshot over its older mirror: no CLI tab, the stale binding,
  // and a tab a peer created on the host.
  function windowPull() {
    const read = session()
    return {
      tabsByWorktree: {
        [WORKTREE_ID]: [...read.tabsByWorktree[WORKTREE_ID], tab(HOST_TAB, 'pty-peer')]
      },
      terminalLayoutsByTabId: read.terminalLayoutsByTabId
    }
  }

  function importInto(main: WorkspaceSessionState, publishedSince: boolean) {
    let written: Partial<WorkspaceSessionState> = {}
    const kept = importPeerTopology(
      {
        getWorkspaceSession: () => main,
        patchWorkspaceSession: (patch) => {
          written = patch
        }
      },
      'target-1',
      windowPull(),
      () => publishedSince
    )
    return { kept, written }
  }

  it("keeps main's newer rows and adds the host's new tab", () => {
    const { kept, written } = importInto(mainAfterWindowRead(), true)

    expect(written.tabsByWorktree?.[WORKTREE_ID]?.map((row) => row.id)).toEqual([
      SPLIT_TAB,
      PINNED_TAB,
      NEW_TAB,
      HOST_TAB
    ])
    expect(written.terminalLayoutsByTabId?.[SPLIT_TAB]?.ptyIdsByLeafId?.[LEAF_2]).toBe(
      'pty-2-bound-late'
    )
    expect(kept).toBe(true)
  })

  it('does not revive a tab main closed after the window read it', () => {
    const main = mainAfterWindowRead()
    const { written } = importInto(
      {
        ...main,
        closedTerminalTabTombstonesByTabId: {
          [HOST_TAB]: { closedAt: Date.now(), worktreeId: WORKTREE_ID, reason: 'user' }
        }
      },
      true
    )

    expect(written.tabsByWorktree?.[WORKTREE_ID]?.map((row) => row.id)).not.toContain(HOST_TAB)
  })

  it('applies the pull as the window merged it when main has published nothing since', () => {
    const unfenced = { ...mainAfterWindowRead(), terminalTopologyRevisionByRepoId: {} }
    const { kept, written } = importInto(unfenced, false)

    expect(written).toEqual(windowPull())
    expect(kept).toBe(false)
  })

  it("keeps main's rows and adds no host tab in a repo main fenced, as its rebase did", () => {
    const { written } = importInto(mainAfterWindowRead(), false)

    expect(written.tabsByWorktree?.[WORKTREE_ID]?.map((row) => row.id)).toEqual([
      SPLIT_TAB,
      PINNED_TAB,
      NEW_TAB
    ])
  })
})

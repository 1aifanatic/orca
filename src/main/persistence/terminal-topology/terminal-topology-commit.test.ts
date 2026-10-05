import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { makeTerminalTab, testState } from '../../persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit,
  type TerminalSurfaceCloseOptions
} from '../../runtime/terminal-surface-close'
import { closeLeafOrTab } from './terminal-topology-commit'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Fixture = { hostId: ExecutionHostId; worktreeId: string; repoId: string }

// An ssh: partition: the close must land in the owning host's partition, not local.
const fixture: Fixture = {
  hostId: 'ssh:target-1',
  worktreeId: 'ssh-repo::/srv/app',
  repoId: 'ssh-repo'
}

const SPLIT_TAB = 'tab-split'
const PINNED_TAB = 'tab-pinned'
const CLOSED_TAB = 'tab-closed-earlier'

function sessionFor(fixture: Fixture): WorkspaceSessionState {
  const { worktreeId } = fixture
  return {
    activeRepoId: fixture.repoId,
    activeWorktreeId: worktreeId,
    activeTabId: SPLIT_TAB,
    tabsByWorktree: {
      [worktreeId]: [
        makeTerminalTab({ id: SPLIT_TAB, ptyId: 'pty-1', worktreeId }),
        makeTerminalTab({ id: PINNED_TAB, ptyId: 'pty-3', worktreeId, isPinned: true })
      ]
    },
    terminalLayoutsByTabId: {
      [SPLIT_TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: TEST_LEAF_1 },
          second: { type: 'leaf', leafId: TEST_LEAF_2 }
        },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1', [TEST_LEAF_2]: 'pty-2' },
        buffersByLeafId: { [TEST_LEAF_2]: 'scrollback' },
        titlesByLeafId: { [TEST_LEAF_2]: 'logs' }
      },
      [PINNED_TAB]: {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-3' }
      }
    },
    terminalPtyIncarnationsByPaneKey: {
      [`${SPLIT_TAB}:${TEST_LEAF_1}`]: 'inc-1',
      [`${SPLIT_TAB}:${TEST_LEAF_2}`]: 'inc-2'
    },
    remoteSessionIdsByTabId: { [SPLIT_TAB]: 'remote-1' },
    closedTerminalTabTombstonesByTabId: {
      [CLOSED_TAB]: { closedAt: 1_699_999_999_000, worktreeId, reason: 'user' }
    },
    terminalTopologyRevisionByRepoId: { [fixture.repoId]: 3 }
  }
}

type CloseCase = {
  name: string
  target: TerminalSurfaceCloseTarget
  options?: TerminalSurfaceCloseOptions
}

const PANE_CLOSE: CloseCase = {
  name: 'pane of a split',
  target: { kind: 'pane', tabId: SPLIT_TAB, leafId: TEST_LEAF_2 }
}
const TAB_CLOSE: CloseCase = {
  name: 'tab',
  target: { kind: 'tab', tabId: SPLIT_TAB },
  options: { reason: 'user' }
}
const PINNED_TAB_CLOSE: CloseCase = {
  name: 'pinned tab',
  target: { kind: 'tab', tabId: PINNED_TAB }
}
const RECORDED_CLOSE_ECHO: CloseCase = {
  name: 'echo of a recorded close',
  target: { kind: 'tab', tabId: CLOSED_TAB },
  options: { allowMissing: true }
}

/** Runs one close through `mutationFor` and records every byte it hands back. */
function runClose(
  closeCase: CloseCase,
  mutationFor: (
    commit: TerminalSurfaceCloseCommit
  ) => () => { value: Error | undefined; persist?: boolean | 'if-dirty' }
): string {
  const sessions = new Map<ExecutionHostId, WorkspaceSessionState>([
    [fixture.hostId, sessionFor(fixture)]
  ])
  const writes: unknown[] = []
  let killed: string[] | null = null
  const mutation = mutationFor({
    worktreeId: fixture.worktreeId,
    target: closeCase.target,
    options: closeCase.options ?? {},
    requestedSession: sessionFor(fixture),
    ownerMatches: () => true,
    hostId: () => fixture.hostId,
    getSession: (hostId) => sessions.get(hostId),
    setSession: (session, hostId) => {
      writes.push({ hostId, session })
      sessions.set(hostId, session)
    },
    onClosed: (ptyIds) => {
      killed = ptyIds
    }
  })
  const result = mutation()
  return JSON.stringify({
    value: result.value instanceof Error ? result.value.message : result.value,
    persist: result.persist,
    writes,
    killed
  })
}

describe('closeLeafOrTab writes exactly what the close mutation writes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const closeCase of [PANE_CLOSE, TAB_CLOSE]) {
    it(closeCase.name, () => {
      const legacy = runClose(closeCase, terminalSurfaceCloseMutation)
      expect(legacy).toContain('"writes":[{')
      expect(runClose(closeCase, closeLeafOrTab)).toBe(legacy)
    })
  }
})

describe('persistence.terminal-topology span', () => {
  let records: { name: string; attributes: Record<string, unknown>; exit: unknown }[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_700_000_000_000)
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

  function attributesOf(closeCase: CloseCase): Record<string, unknown> {
    runClose(closeCase, closeLeafOrTab)
    expect(records).toHaveLength(1)
    expect(records[0].name).toBe('persistence.terminal-topology')
    return records[0].attributes
  }

  it('records a committed pane close without ids', () => {
    const attributes = attributesOf(PANE_CLOSE)
    expect(attributes).toEqual({
      kind: 'persistence',
      'topology.kind': 'close_leaf',
      'topology.outcome': 'committed'
    })
    expect(JSON.stringify(records[0])).not.toMatch(/pty-|tab-split|ssh-repo|srv|remote-1/)
  })

  it('records a refusal with its reason code', () => {
    expect(attributesOf(PINNED_TAB_CLOSE)).toMatchObject({
      'topology.kind': 'close_tab',
      'topology.outcome': 'refused',
      'topology.refusal': 'terminal_tab_pinned'
    })
  })

  it('records a close that changes nothing as a noop', () => {
    expect(attributesOf(RECORDED_CLOSE_ECHO)).toMatchObject({ 'topology.outcome': 'noop' })
  })

  it('records a thrown commit as a failed span and rethrows', () => {
    const mutation = closeLeafOrTab({
      worktreeId: fixture.worktreeId,
      target: { kind: 'tab', tabId: SPLIT_TAB },
      options: {},
      requestedSession: undefined,
      ownerMatches: () => true,
      hostId: () => fixture.hostId,
      getSession: () => {
        throw new Error('read failed')
      },
      setSession: () => {},
      onClosed: () => {}
    })
    expect(mutation).toThrow('read failed')
    expect(records).toHaveLength(1)
    expect(records[0].attributes).toMatchObject({ 'topology.outcome': 'threw' })
    expect(records[0].exit).toMatchObject({ _tag: 'Failure' })
  })
})

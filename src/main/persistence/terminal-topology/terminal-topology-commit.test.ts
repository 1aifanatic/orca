import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalSurfaceCloseTarget } from '../../../shared/terminal-surface-close-target'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { createStore, makeTerminalTab, testState } from '../../persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import {
  terminalSurfaceCloseMutation,
  type TerminalSurfaceCloseCommit,
  type TerminalSurfaceCloseOptions
} from '../../runtime/terminal-surface-close'
import type { PersistPtyBindingArgs } from '../loading-store/pty-binding-persistence'
import { bindLeaf, closeLeaf, closeTab } from './terminal-topology-commit'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

type Fixture = { name: string; hostId: ExecutionHostId; worktreeId: string; repoId: string }

const FIXTURES: Fixture[] = [
  { name: 'local worktree', hostId: 'local', worktreeId: 'repo1::/w', repoId: 'repo1' },
  {
    name: 'ssh: partition',
    hostId: 'ssh:target-1',
    worktreeId: 'ssh-repo::/srv/app',
    repoId: 'ssh-repo'
  },
  {
    name: 'folder workspace',
    hostId: 'local',
    worktreeId: folderWorkspaceKey('fw-1'),
    repoId: folderWorkspaceKey('fw-1')
  }
]

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
  ownerMatches?: boolean
}

const CLOSE_CASES: CloseCase[] = [
  { name: 'pane of a split', target: { kind: 'pane', tabId: SPLIT_TAB, leafId: TEST_LEAF_2 } },
  {
    name: 'only pane (not widened)',
    target: { kind: 'pane', tabId: PINNED_TAB, leafId: TEST_LEAF_1 }
  },
  { name: 'tab', target: { kind: 'tab', tabId: SPLIT_TAB }, options: { reason: 'user' } },
  { name: 'pinned tab', target: { kind: 'tab', tabId: PINNED_TAB } },
  {
    name: 'forced pinned tab',
    target: { kind: 'tab', tabId: PINNED_TAB },
    options: { force: true }
  },
  { name: 'missing tab', target: { kind: 'tab', tabId: 'tab-gone' } },
  {
    name: 'missing tab, allowMissing',
    target: { kind: 'tab', tabId: 'tab-gone' },
    options: { allowMissing: true, reason: 'cleanup' }
  },
  {
    name: 'echo of a recorded close',
    target: { kind: 'tab', tabId: CLOSED_TAB },
    options: { allowMissing: true }
  },
  { name: 'owner changed', target: { kind: 'tab', tabId: SPLIT_TAB }, ownerMatches: false }
]

/** Runs one close through `mutationFor` and records every byte it hands back. */
function runClose(
  fixture: Fixture,
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
    ownerMatches: () => closeCase.ownerMatches ?? true,
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

function closeThroughCommitModule(
  commit: TerminalSurfaceCloseCommit
): () => { value: Error | undefined; persist?: boolean | 'if-dirty' } {
  const { target } = commit
  return target.kind === 'pane' ? closeLeaf({ ...commit, target }) : closeTab({ ...commit, target })
}

describe('closeLeaf / closeTab write exactly what the close mutation writes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const fixture of FIXTURES) {
    for (const closeCase of CLOSE_CASES) {
      it(`${fixture.name}: ${closeCase.name}`, () => {
        const legacy = runClose(fixture, closeCase, terminalSurfaceCloseMutation)
        const committed = runClose(fixture, closeCase, closeThroughCommitModule)
        expect(committed).toBe(legacy)
      })
    }
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

  const fixture = FIXTURES[1]

  function attributesOf(closeCase: CloseCase): Record<string, unknown> {
    runClose(fixture, closeCase, closeThroughCommitModule)
    expect(records).toHaveLength(1)
    expect(records[0].name).toBe('persistence.terminal-topology')
    return records[0].attributes
  }

  it('records a committed pane close without ids', () => {
    const attributes = attributesOf(CLOSE_CASES[0])
    expect(attributes).toEqual({
      kind: 'persistence',
      'topology.kind': 'close_leaf',
      'topology.outcome': 'committed'
    })
    expect(JSON.stringify(records[0])).not.toMatch(/pty-|tab-split|ssh-repo|srv|remote-1/)
  })

  it('records a refusal with its reason code', () => {
    expect(attributesOf(CLOSE_CASES[3])).toMatchObject({
      'topology.kind': 'close_tab',
      'topology.outcome': 'refused',
      'topology.refusal': 'terminal_tab_pinned'
    })
  })

  it('records a close that changes nothing as a noop', () => {
    const echo = CLOSE_CASES.find((closeCase) => closeCase.name === 'echo of a recorded close')
    expect(attributesOf(echo!)).toMatchObject({ 'topology.outcome': 'noop' })
  })

  it('records a thrown commit as a failed span and rethrows', () => {
    const mutation = closeTab({
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

describe('bindLeaf is the binding writer', () => {
  const dirs: string[] = []
  const freshStore = (): ReturnType<typeof createStore> => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-topology-commit-'))
    dirs.push(testState.dir)
    return createStore()
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forwards its arguments and result unchanged', async () => {
    const persistPtyBinding = vi.fn(async () => false)
    const args: PersistPtyBindingArgs = {
      worktreeId: 'repo1::/w',
      tabId: SPLIT_TAB,
      leafId: TEST_LEAF_1,
      ptyId: 'pty-1'
    }
    await expect(bindLeaf({ persistPtyBinding }, args, 'ssh:target-1')).resolves.toBe(false)
    expect(persistPtyBinding).toHaveBeenCalledWith(args, 'ssh:target-1')
  })

  for (const fixture of FIXTURES) {
    it(`${fixture.name}: binds byte-identically to persistPtyBinding`, async () => {
      const bindings: PersistPtyBindingArgs[] = [
        // Rebind an existing leaf, mint a new tab, then graft a new leaf into it.
        { worktreeId: fixture.worktreeId, tabId: SPLIT_TAB, leafId: TEST_LEAF_2, ptyId: 'pty-9' },
        { worktreeId: fixture.worktreeId, tabId: 'tab-new', leafId: TEST_LEAF_1, ptyId: 'pty-7' },
        { worktreeId: fixture.worktreeId, tabId: 'tab-new', leafId: TEST_LEAF_2, ptyId: 'pty-8' }
      ]
      const run = async (
        bind: (
          store: ReturnType<typeof createStore>,
          args: PersistPtyBindingArgs
        ) => Promise<boolean>
      ): Promise<string> => {
        const store = freshStore()
        store.setWorkspaceSession(sessionFor(fixture), fixture.hostId)
        const results: boolean[] = []
        for (const args of bindings) {
          results.push(await bind(store, { ...args, incarnationId: `inc-${args.ptyId}` }))
        }
        return JSON.stringify({ results, session: store.getWorkspaceSession(fixture.hostId) })
      }
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(1_700_000_000_000)
      try {
        const legacy = await run((store, args) => store.persistPtyBinding(args, fixture.hostId))
        const committed = await run((store, args) => bindLeaf(store, args, fixture.hostId))
        expect(committed).toBe(legacy)
        expect(legacy).toContain('pty-9')
      } finally {
        vi.useRealTimers()
      }
    })
  }
})

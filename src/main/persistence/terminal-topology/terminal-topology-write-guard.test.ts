import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retirePersistedStablePaneOwner } from '../../ipc/pty/pane/stable-owner'
import { createStore, makeTerminalTab, testState } from '../../persistence-test-harness'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { topologyClassAChanges } from './terminal-topology-class-a-diff'
import {
  armTopologyWriteGuardForTests,
  observeTopologySinkWrite,
  takeTopologyWriteGuardReport,
  withTopologyCommit
} from './terminal-topology-write-guard'
import { UNROUTED_TOPOLOGY_WRITERS } from './terminal-topology-unrouted-writers'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WORKTREE = 'repo1::/w'
const TAB = 'tab-1'
const STABLE_OWNER = 'src/main/ipc/pty/pane/stable-owner.ts'

function boundSession(): WorkspaceSessionState {
  return {
    activeRepoId: 'repo1',
    activeWorktreeId: WORKTREE,
    activeTabId: TAB,
    tabsByWorktree: {
      [WORKTREE]: [makeTerminalTab({ id: TAB, ptyId: 'pty-1', worktreeId: WORKTREE })]
    },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: TEST_LEAF_1 },
          second: { type: 'leaf', leafId: TEST_LEAF_2 }
        },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1', [TEST_LEAF_2]: 'pty-2' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [`${TAB}:${TEST_LEAF_2}`]: 'inc-2' },
    terminalTopologyRevisionByRepoId: { repo1: 1 }
  }
}

/** R19, a real writer that still bypasses the commit module: retires the second pane. */
async function retireSecondPane(store: ReturnType<typeof createStore>): Promise<boolean> {
  return retirePersistedStablePaneOwner(
    store,
    { tabId: TAB, leafId: TEST_LEAF_2, ptyId: 'pty-2', persistedIncarnationId: 'inc-2' },
    WORKTREE,
    null
  )
}

// The suite-wide arming (vitest setup) is replaced per test, then restored for the next file's tests.
const suiteGuard = globalThis.__orcaTerminalTopologyWriteGuard

describe('terminal topology write guard', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-topology-guard-'))
    store = createStore()
    store.setWorkspaceSession(boundSession())
  })
  afterEach(() => {
    takeTopologyWriteGuardReport()
    globalThis.__orcaTerminalTopologyWriteGuard = suiteGuard
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reports an unrouted writer that changes class (a) outside a commit', async () => {
    armTopologyWriteGuardForTests({ allowedWriters: new Set(), freeze: false, repoRoot: REPO_ROOT })
    expect(await retireSecondPane(store)).toBe(true)
    const { violations, allowed } = takeTopologyWriteGuardReport()
    expect(allowed).toEqual([])
    expect(violations).toHaveLength(1)
    expect(violations[0].writer).toBe(STABLE_OWNER)
    expect(violations[0].changes).toEqual(
      expect.arrayContaining([`tab:${TAB}.root`, `tab:${TAB}.ptyIdsByLeafId`, 'revision'])
    )
  })

  it('passes an allowlisted writer and lists it in the report', async () => {
    expect(UNROUTED_TOPOLOGY_WRITERS).toHaveProperty([STABLE_OWNER])
    armTopologyWriteGuardForTests({
      allowedWriters: new Set(Object.keys(UNROUTED_TOPOLOGY_WRITERS)),
      freeze: false,
      repoRoot: REPO_ROOT
    })
    expect(await retireSecondPane(store)).toBe(true)
    const { violations, allowed } = takeTopologyWriteGuardReport()
    expect(violations).toEqual([])
    expect(allowed.map((entry) => entry.writer)).toEqual([STABLE_OWNER])
  })

  it('admits the same write inside a commit scope', () => {
    armTopologyWriteGuardForTests({ allowedWriters: new Set(), freeze: false, repoRoot: REPO_ROOT })
    const prior = boundSession()
    const next = { ...prior, terminalTopologyRevisionByRepoId: { repo1: 2 } }
    withTopologyCommit(() => observeTopologySinkWrite(prior, next))
    expect(takeTopologyWriteGuardReport().violations).toEqual([])
  })

  it('treats a test seeding the store as no writer', () => {
    armTopologyWriteGuardForTests({ allowedWriters: new Set(), freeze: false, repoRoot: REPO_ROOT })
    store.setWorkspaceSession({ ...boundSession(), terminalTopologyRevisionByRepoId: { repo1: 5 } })
    expect(takeTopologyWriteGuardReport()).toEqual({ violations: [], allowed: [] })
  })

  it('freezes published sessions so an in-place write throws at the writer', () => {
    armTopologyWriteGuardForTests({ allowedWriters: new Set(), freeze: true, repoRoot: REPO_ROOT })
    store.setWorkspaceSession(boundSession())
    const published = store.getWorkspaceSession()
    expect(() => {
      published.terminalLayoutsByTabId[TAB].ptyIdsByLeafId![TEST_LEAF_1] = 'pty-stolen'
    }).toThrow(TypeError)
    expect(() => {
      published.tabsByWorktree[WORKTREE][0].ptyId = null
    }).toThrow(TypeError)
  })

  // Pins why the suite-wide arming leaves freeze off: the binding write is still in place (P1)
  // until it becomes copy-on-write in B1-4.
  it('the binding write still mutates the published session in place', async () => {
    armTopologyWriteGuardForTests({ allowedWriters: new Set(), freeze: true, repoRoot: REPO_ROOT })
    store.setWorkspaceSession(boundSession())
    await expect(
      store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: TAB,
        leafId: TEST_LEAF_2,
        ptyId: 'pty-9'
      })
    ).rejects.toThrow(TypeError)
  })
})

describe('class (a) comparison', () => {
  it('names each changed class-(a) slice', () => {
    const prior = boundSession()
    const next: WorkspaceSessionState = {
      ...prior,
      tabsByWorktree: { [WORKTREE]: [], 'repo1::/other': prior.tabsByWorktree[WORKTREE] },
      terminalLayoutsByTabId: {
        [TAB]: {
          ...prior.terminalLayoutsByTabId[TAB],
          titlesByLeafId: { [TEST_LEAF_1]: 'build' }
        }
      },
      sleepingAgentSessionsByPaneKey: {
        [`${TAB}:${TEST_LEAF_1}`]: {
          paneKey: `${TAB}:${TEST_LEAF_1}`,
          worktreeId: WORKTREE,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'session-1' },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1
        }
      },
      remoteSessionIdsByTabId: { [TAB]: 'remote-1' },
      closedTerminalTabTombstonesByTabId: {
        'tab-closed': { closedAt: 1, worktreeId: WORKTREE }
      },
      defaultTerminalTabsAppliedByWorktreeId: { [WORKTREE]: true }
    }
    expect(topologyClassAChanges(prior, next).sort()).toEqual(
      [
        `tab:${TAB}.owners`,
        `tab:${TAB}.titlesByLeafId`,
        `tab:${TAB}.sleeping`,
        `tab:${TAB}.remoteSessionId`,
        'tab:tab-closed.closedTombstone',
        'default_applied'
      ].sort()
    )
  })

  it('ignores buffers, scrollback and presentation', () => {
    const prior = boundSession()
    const layout = prior.terminalLayoutsByTabId[TAB]
    const next: WorkspaceSessionState = {
      ...prior,
      activeTabId: null,
      tabsByWorktree: {
        [WORKTREE]: [{ ...prior.tabsByWorktree[WORKTREE][0], title: 'renamed', color: 'red' }]
      },
      terminalLayoutsByTabId: {
        [TAB]: {
          ...layout,
          activeLeafId: TEST_LEAF_2,
          buffersByLeafId: { [TEST_LEAF_1]: 'scrollback' },
          scrollbackRefsByLeafId: { [TEST_LEAF_1]: 'ref-1' }
        }
      },
      localOnlyScrollbackByTabId: { [TAB]: { [TEST_LEAF_1]: 'local' } }
    }
    expect(topologyClassAChanges(prior, next)).toEqual([])
  })

  it('compares by value, so a rebuilt but equal session is no change', () => {
    const prior = boundSession()
    expect(topologyClassAChanges(prior, structuredClone(prior))).toEqual([])
  })
})

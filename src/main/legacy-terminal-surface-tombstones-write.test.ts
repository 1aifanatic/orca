import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { hasHostAuthoritativeTerminalMembership } from './persistence/terminal-topology/terminal-topology-membership'
import {
  createStore,
  makeRepo,
  makeTerminalTab,
  testState,
  writeDataFile
} from './persistence-test-harness'
import { TEST_LEAF_1 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'
const RUNTIME_HOST = 'runtime:env-1'

/** A session an older build saved: its close record was left for the next write to apply. */
function sessionWithUnappliedClose(incarnationId: string): Partial<WorkspaceSessionState> {
  return {
    tabsByWorktree: {
      [WORKTREE]: [makeTerminalTab({ id: 'closed-tab', ptyId: 'pty-1', worktreeId: WORKTREE })]
    },
    terminalLayoutsByTabId: {
      'closed-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [`closed-tab:${TEST_LEAF_1}`]: 'incarnation-a' },
    terminalSurfaceTombstonesByPaneKey: {
      [`closed-tab:${TEST_LEAF_1}`]: {
        worktreeId: WORKTREE,
        parentTabId: 'closed-tab',
        leafId: TEST_LEAF_1,
        ptyId: 'pty-1',
        incarnationId,
        retiredAt: 42
      }
    }
  }
}

async function storeLoadedWith(hostId: string | null, incarnationId: string) {
  const persisted = getDefaultPersistedState(testState.dir)
  persisted.repos = [makeRepo({ id: 'repo1', path: '/repo1' })]
  const session = { ...persisted.workspaceSession, ...sessionWithUnappliedClose(incarnationId) }
  if (hostId) {
    persisted.workspaceSessionsByHostId = { [hostId]: session }
  } else {
    persisted.workspaceSession = session
  }
  writeDataFile(persisted)
  return createStore()
}

describe('close records an older build left unapplied', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('are applied by the first write, so the closed tab stays closed, then dropped', async () => {
    const store = await storeLoadedWith(null, 'incarnation-a')

    store.setWorkspaceSession(store.getWorkspaceSession())

    const written = store.getWorkspaceSession()
    expect(written.tabsByWorktree[WORKTREE]).toEqual([])
    expect(written.terminalLayoutsByTabId['closed-tab']).toBeUndefined()
    expect(written.terminalSurfaceTombstonesByPaneKey).toEqual({})
  })

  it('are dropped when they cannot apply, so a runtime partition is not host-authoritative', async () => {
    const store = await storeLoadedWith(RUNTIME_HOST, 'incarnation-b')

    store.setWorkspaceSession(store.getWorkspaceSession(RUNTIME_HOST), RUNTIME_HOST)

    const written = store.getWorkspaceSession(RUNTIME_HOST)
    expect(written.tabsByWorktree[WORKTREE]).toHaveLength(1)
    expect(written.terminalSurfaceTombstonesByPaneKey).toEqual({})
    expect(hasHostAuthoritativeTerminalMembership(written, WORKTREE)).toBe(false)
  })
})

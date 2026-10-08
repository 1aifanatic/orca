import {
  closeTestStores,
  createStore,
  makeTerminalTab,
  testState
} from './persistence-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { Tab } from '../shared/tab-types'
import type { TerminalLayoutSnapshot } from '../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { setRendererSession } from './persistence/terminal-topology/terminal-renderer-presentation-save'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'

const mainLayout: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    ratio: 0.5,
    first: { type: 'leaf', leafId: TEST_LEAF_1 },
    second: { type: 'leaf', leafId: TEST_LEAF_2 }
  },
  activeLeafId: TEST_LEAF_1,
  expandedLeafId: null,
  ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-held', [TEST_LEAF_2]: 'pty-held-2' }
}

function unified(id: string, groupId: string): Tab {
  return {
    id,
    entityId: id,
    groupId,
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** What main holds: a split tab and a legacy tab with no layout, in a fenced repo. */
function mainSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    tabsByWorktree: {
      [WORKTREE]: [
        makeTerminalTab({ id: 'held', worktreeId: WORKTREE, ptyId: 'pty-held' }),
        makeTerminalTab({ id: 'bare', worktreeId: WORKTREE, ptyId: null, sortOrder: 1 })
      ]
    },
    terminalLayoutsByTabId: { held: mainLayout },
    unifiedTabs: { [WORKTREE]: [unified('held', 'group-a'), unified('bare', 'group-a')] },
    tabGroups: {
      [WORKTREE]: [
        { id: 'group-a', worktreeId: WORKTREE, activeTabId: 'held', tabOrder: ['held', 'bare'] }
      ]
    },
    activeTabIdByWorktree: { [WORKTREE]: 'held' },
    terminalPtyIncarnationsByPaneKey: { [`held:${TEST_LEAF_1}`]: 'incarnation-main' },
    terminalTopologyRevisionByRepoId: { repo1: 1 }
  }
}

describe('a window save keeps what the window presents and drops what main does not hold', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-window-save-presentation-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps pin, view mode, generated and AI Vault titles, launch pane fate and chat pane', async () => {
    const store = await createStore()
    store.setWorkspaceSession(mainSession())
    const presentation = {
      isPinned: true,
      viewMode: 'chat',
      generatedTitle: 'Fix the flaky test',
      aiVaultTitle: { agent: 'codex', sessionId: 'session-1', title: 'Vault title' },
      agentLaunchPane: { leafId: TEST_LEAF_1, outcome: { kind: 'unconfirmed' } }
    } as const

    setRendererSession(store, {
      ...mainSession(),
      tabsByWorktree: {
        [WORKTREE]: [
          makeTerminalTab({ id: 'held', worktreeId: WORKTREE, ptyId: 'pty-held', ...presentation }),
          makeTerminalTab({ id: 'bare', worktreeId: WORKTREE, ptyId: null, sortOrder: 1 })
        ]
      },
      terminalLayoutsByTabId: { held: { ...mainLayout, chatLeafId: TEST_LEAF_2 } }
    })

    const saved = store.getWorkspaceSession()
    expect(saved.tabsByWorktree[WORKTREE]?.[0]).toMatchObject(presentation)
    expect(saved.terminalLayoutsByTabId.held?.chatLeafId).toBe(TEST_LEAF_2)
  })

  it('a window layout for a tab main holds without one is not saved', async () => {
    const store = await createStore()
    store.setWorkspaceSession(mainSession())

    setRendererSession(store, {
      ...mainSession(),
      terminalLayoutsByTabId: {
        held: mainLayout,
        bare: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: null,
          expandedLeafId: null
        }
      }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId).not.toHaveProperty('bare')
  })

  it("a mixed-version window's incarnations and surface tombstones are not saved", async () => {
    const store = await createStore()
    store.setWorkspaceSession(mainSession())

    setRendererSession(store, {
      ...mainSession(),
      terminalPtyIncarnationsByPaneKey: { [`held:${TEST_LEAF_2}`]: 'incarnation-window' },
      terminalSurfaceTombstonesByPaneKey: {
        [`held:${TEST_LEAF_2}`]: {
          worktreeId: WORKTREE,
          parentTabId: 'held',
          leafId: TEST_LEAF_2,
          ptyId: 'pty-held-2',
          incarnationId: 'incarnation-window',
          retiredAt: 2
        }
      }
    })

    const saved = store.getWorkspaceSession()
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual({
      [`held:${TEST_LEAF_1}`]: 'incarnation-main'
    })
    expect(saved.terminalSurfaceTombstonesByPaneKey ?? {}).toEqual({})
    expect(saved.terminalLayoutsByTabId.held?.root).toEqual(mainLayout.root)
  })

  it('a createTab-era empty layout gets back the panes main holds', async () => {
    const store = await createStore()
    store.setWorkspaceSession(mainSession())

    setRendererSession(store, {
      ...mainSession(),
      terminalLayoutsByTabId: { held: { root: null, activeLeafId: null, expandedLeafId: null } }
    })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId.held?.root).toEqual(mainLayout.root)
  })

  it('a group left holding only a tab main dropped vanishes, with its split slot and recents', async () => {
    const store = await createStore()
    store.setWorkspaceSession(mainSession())

    setRendererSession(store, {
      ...mainSession(),
      unifiedTabs: {
        [WORKTREE]: [
          unified('held', 'group-a'),
          unified('bare', 'group-a'),
          unified('gone', 'group-b')
        ]
      },
      tabGroups: {
        [WORKTREE]: [
          {
            id: 'group-a',
            worktreeId: WORKTREE,
            activeTabId: 'held',
            tabOrder: ['held', 'bare'],
            recentTabIds: ['gone']
          },
          { id: 'group-b', worktreeId: WORKTREE, activeTabId: 'gone', tabOrder: ['gone'] }
        ]
      },
      tabGroupLayouts: {
        [WORKTREE]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-a' },
          second: { type: 'leaf', groupId: 'group-b' }
        }
      }
    })

    const saved = store.getWorkspaceSession()
    expect(saved.tabGroups?.[WORKTREE]).toEqual([
      {
        id: 'group-a',
        worktreeId: WORKTREE,
        activeTabId: 'held',
        tabOrder: ['held', 'bare'],
        recentTabIds: []
      }
    ])
    expect(saved.tabGroupLayouts?.[WORKTREE]).toEqual({ type: 'leaf', groupId: 'group-a' })
  })
})

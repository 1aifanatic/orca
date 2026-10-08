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
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './runtime/mobile-session-terminal-persistence-retirement'
import { setRendererSession } from './persistence/terminal-topology/terminal-renderer-presentation-save'
import { TEST_LEAF_1, TEST_LEAF_2 } from './persistence-session-fixtures'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const WORKTREE = 'repo1::/worktree'
const OTHER_WORKTREE = 'repo1::/other-worktree'

/** The renderer's own publication: it knows only about the tab it created. */
function rendererSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE,
    activeTabId: 'renderer-tab',
    tabsByWorktree: {
      [WORKTREE]: [
        makeTerminalTab({ id: 'renderer-tab', worktreeId: WORKTREE, ptyId: 'renderer-pty' })
      ]
    },
    terminalLayoutsByTabId: {
      'renderer-tab': {
        root: { type: 'leaf', leafId: TEST_LEAF_1 },
        activeLeafId: TEST_LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [TEST_LEAF_1]: 'renderer-pty' }
      }
    }
  }
}

function persistedTabIds(session: WorkspaceSessionState, worktreeId: string): string[] {
  return (session.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id)
}

describe('terminal membership main holds survives a stale window save', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-membership-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps a host-created tab when the window saves its pre-create tab list', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    // `orca terminal create`: the host mints a tab the renderer has never seen.
    expect(
      await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty'
      })
    ).toBe(true)
    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toContain('host-tab')

    // The renderer's debounced writer flushes a snapshot taken before the create.
    setRendererSession(store, rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toContain('host-tab')
  })

  it('keeps a host-created tab in a second worktree of the same repo', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    await store.persistPtyBinding({
      worktreeId: OTHER_WORKTREE,
      tabId: 'host-tab-other',
      leafId: TEST_LEAF_2,
      ptyId: 'host-pty-other'
    })
    setRendererSession(store, rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), OTHER_WORKTREE)).toContain('host-tab-other')
  })

  it('stamps default-terminal-tab markers so a renderer persist snapshot cannot un-apply them', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    expect(
      await store.persistPtyBinding({
        worktreeId: WORKTREE,
        tabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty'
      })
    ).toBe(true)
    expect(store.getWorkspaceSession().defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE]).toBe(
      true
    )

    setRendererSession(store, rendererSession())
    expect(store.getWorkspaceSession().defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE]).toBe(
      true
    )
  })

  // A window's own spawn is main's too: its save no longer authors membership for any repo.
  it('keeps a window-spawned tab when the window saves a tab list from before the spawn', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())

    await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: 'renderer-second-tab',
      leafId: TEST_LEAF_2,
      ptyId: 'renderer-second-pty'
    })
    setRendererSession(store, rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual([
      'renderer-tab',
      'renderer-second-tab'
    ])
  })

  // Closes are main's: the retirement is computed from the store's own session.
  it('still lets the retirement path close the host-created tab', async () => {
    const store = await createStore()
    store.setWorkspaceSession(rendererSession())
    await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: 'host-tab',
      leafId: TEST_LEAF_2,
      ptyId: 'host-pty',
      incarnationId: 'host-incarnation'
    })

    store.setWorkspaceSession(
      retireTerminalSurfaceFromPersistence(store.getWorkspaceSession(), {
        worktreeId: WORKTREE,
        parentTabId: 'host-tab',
        leafId: TEST_LEAF_2,
        ptyId: 'host-pty',
        incarnationId: 'host-incarnation'
      })
    )
    // A stale window save must not resurrect it either.
    setRendererSession(store, rendererSession())

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual(['renderer-tab'])
  })

  // Main's own writers read and write the store directly; nothing rebases their edit away.
  it("writes a main writer's unfenced tab removal as is, in a repo main already fenced", async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...rendererSession(),
      terminalTopologyRevisionByRepoId: { repo1: 1 }
    })
    await store.persistPtyBinding({
      worktreeId: WORKTREE,
      tabId: 'host-tab',
      leafId: TEST_LEAF_2,
      ptyId: 'host-pty'
    })
    const fenced = store.getWorkspaceSession()
    expect(fenced.terminalTopologyRevisionByRepoId?.repo1).toBeGreaterThan(0)

    const { 'host-tab': _removed, ...layouts } = fenced.terminalLayoutsByTabId
    store.setWorkspaceSession({
      ...fenced,
      tabsByWorktree: {
        [WORKTREE]: fenced.tabsByWorktree[WORKTREE].filter((tab) => tab.id !== 'host-tab')
      },
      terminalLayoutsByTabId: layouts
    })

    expect(persistedTabIds(store.getWorkspaceSession(), WORKTREE)).toEqual(['renderer-tab'])
    expect(store.getWorkspaceSession().terminalLayoutsByTabId).not.toHaveProperty('host-tab')
  })
})

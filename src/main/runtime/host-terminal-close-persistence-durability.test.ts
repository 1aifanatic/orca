/**
 * Seam: main's binding write advances the repo's topology fence on every membership change, and
 * a window save cannot change membership, so a close is main's commit and stays durable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { createStore, testState } from '../persistence-test-harness'
import { setRendererSession } from '../persistence/terminal-topology/terminal-renderer-presentation-save'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'

vi.mock('electron', () => ({
  app: { getPath: () => testStateDirRef.dir, getName: () => 'orca', getVersion: () => '0.0.0' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] },
  webContents: { fromId: () => null },
  ipcMain: { on: () => {}, handle: () => {}, removeListener: () => {} },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const testStateDirRef = vi.hoisted(() => ({ dir: '' }))

const REPO_ID = 'repo-1'
const WT = `${REPO_ID}::/tmp/wt-cli`
const TAB = 'cli-tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = `${WT}@@a1b2c3d4`
const SECOND_LEAF = '22222222-2222-4222-8222-222222222222'
const INCARNATION = '33333333-3333-4333-8333-333333333333'

function windowSaveWithout(session: WorkspaceSessionState, tabId: string): WorkspaceSessionState {
  // A window save after hiding `tabId`: the row is gone, and the window never writes the fence.
  const next: WorkspaceSessionState = {
    ...session,
    tabsByWorktree: {
      ...session.tabsByWorktree,
      [WT]: (session.tabsByWorktree?.[WT] ?? []).filter((tab) => tab.id !== tabId)
    }
  }
  delete next.terminalTopologyRevisionByRepoId
  return next
}

async function makeStore() {
  return await createStore()
}

describe('host-created terminal close durability', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-close-durability-'))
    testStateDirRef.dir = testState.dir
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('a window save that omits a row main holds does not remove it', async () => {
    const store = await makeStore()
    await store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    setRendererSession(store, windowSaveWithout(store.getWorkspaceSession(), TAB))
    expect(store.getWorkspaceSession().tabsByWorktree?.[WT]?.map((t) => t.id)).toEqual([TAB])
  })

  it("main's close stays durable through later stale window saves", async () => {
    const store = await makeStore()
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: TAB,
      leafId: LEAF,
      ptyId: PTY,
      incarnationId: INCARNATION
    })
    const stale = structuredClone(store.getWorkspaceSession())
    store.setWorkspaceSession(
      retireTerminalSurfaceFromPersistence(store.getWorkspaceSession(), {
        worktreeId: WT,
        parentTabId: TAB,
        leafId: LEAF,
        ptyId: PTY,
        incarnationId: INCARNATION
      })
    )
    // Kill-failure shape: no exit, just more window saves that still list the tab.
    for (let i = 0; i < 3; i += 1) {
      setRendererSession(store, structuredClone(stale))
    }
    expect(store.getWorkspaceSession().tabsByWorktree?.[WT] ?? []).toEqual([])
  })
})

/** Pins the fence seam itself: every membership change main's binding write makes advances it. */
describe('topology fence census', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-fence-census-'))
    testStateDirRef.dir = testState.dir
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('every host-create binding shape advances a fresh repo fence', async () => {
    for (const [index, extra] of [
      {},
      { incarnationId: INCARNATION },
      { startupCwd: '/tmp/wt-cli' }
    ].entries()) {
      const store = await makeStore()
      await store.persistPtyBinding({
        worktreeId: WT,
        tabId: `${TAB}-${index}`,
        leafId: LEAF,
        ptyId: `${PTY}-${index}`,
        ...extra
      })
      expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(1)
    }
  })

  it('a second pane advances it; rebinding a held pane does not', async () => {
    const store = await makeStore()
    await store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    const second = { worktreeId: WT, tabId: TAB, leafId: SECOND_LEAF, ptyId: `${PTY}-b` }
    await store.persistPtyBinding(second)
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(2)
    await store.persistPtyBinding({ ...second, ptyId: `${PTY}-c` })
    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(2)
  })

  it('an armed fence keeps climbing', async () => {
    const store = await makeStore()
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 1 }
    })
    await store.persistPtyBinding({ worktreeId: WT, tabId: TAB, leafId: LEAF, ptyId: PTY })
    expect(
      store.getWorkspaceSession().terminalTopologyRevisionByRepoId?.[REPO_ID] ?? 0
    ).toBeGreaterThan(1)
  })
})

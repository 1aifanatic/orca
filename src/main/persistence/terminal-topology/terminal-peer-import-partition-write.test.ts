import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../../persistence-test-harness'
import { Store } from '../loading-store/store'
import { importPeerTopology } from './terminal-topology-commit'

const HOST_ID = 'ssh:target-1'
const WORKTREE_ID = 'ssh-repo::/srv/app'
const LEAF = '11111111-1111-4111-8111-111111111111'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openStore(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-peer-import-'))
  directories.push(directory)
  return createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
}

function tab(id: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function leafLayout(tabId: string): WorkspaceSessionState['terminalLayoutsByTabId'][string] {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF]: `pty-${tabId}` }
  }
}

function mainSession(revision: number): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [WORKTREE_ID]: [tab('main-tab')] },
    terminalLayoutsByTabId: { 'main-tab': leafLayout('main-tab') },
    terminalPtyIncarnationsByPaneKey: { [`main-tab:${LEAF}`]: 'main-incarnation' },
    terminalTopologyRevisionByRepoId: { 'ssh-repo': revision }
  }
}

function importHostPull(store: Store): WorkspaceSessionState {
  importPeerTopology(
    store,
    'target-1',
    {
      tabsByWorktree: { [WORKTREE_ID]: [tab('host-tab')] },
      terminalLayoutsByTabId: { 'host-tab': leafLayout('host-tab') },
      terminalPtyIncarnationsByPaneKey: { [`host-tab:${LEAF}`]: 'host-incarnation' }
    },
    () => false
  )
  return store.getWorkspaceSession(HOST_ID)
}

describe('a host pull into an SSH partition main has published nothing since', () => {
  // As main's membership rebase did: once main fenced the repo, its tabs and panes stand.
  it("keeps main's tabs and pane records in a repo main has fenced, dropping host-only tabs", () => {
    const store = openStore()
    store.setWorkspaceSession(mainSession(1), HOST_ID)

    const saved = importHostPull(store)

    expect(saved.tabsByWorktree[WORKTREE_ID]?.map((row) => row.id)).toEqual(['main-tab'])
    expect(Object.keys(saved.terminalLayoutsByTabId)).toEqual(['main-tab'])
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual({
      [`main-tab:${LEAF}`]: 'main-incarnation'
    })
    expect(saved.terminalTopologyRevisionByRepoId).toEqual({ 'ssh-repo': 1 })
  })

  it("replaces main's rows and the pane records the pull names in a repo main never fenced", () => {
    const store = openStore()
    store.setWorkspaceSession(mainSession(0), HOST_ID)

    const saved = importHostPull(store)

    expect(saved.tabsByWorktree[WORKTREE_ID]?.map((row) => row.id)).toEqual(['host-tab'])
    expect(Object.keys(saved.terminalLayoutsByTabId)).toEqual(['host-tab'])
    expect(saved.terminalPtyIncarnationsByPaneKey).toEqual({
      [`host-tab:${LEAF}`]: 'host-incarnation'
    })
  })

  // Two desktops on one SSH host: a tab this window created starts no fence, so the other's imports.
  it("imports another desktop's new tab after this window created its own", async () => {
    const store = openStore()
    await store.createTerminalSurface(
      {
        worktreeId: WORKTREE_ID,
        tabId: 'main-tab',
        leafId: LEAF,
        placement: { kind: 'new-tab', row: { title: 'Terminal', createdAt: 1 } }
      },
      HOST_ID
    )
    expect(
      store.getWorkspaceSession(HOST_ID).tabsByWorktree[WORKTREE_ID]?.map((row) => row.id)
    ).toEqual(['main-tab'])

    importPeerTopology(
      store,
      'target-1',
      {
        tabsByWorktree: { [WORKTREE_ID]: [tab('main-tab'), tab('host-tab')] },
        terminalLayoutsByTabId: {
          'main-tab': leafLayout('main-tab'),
          'host-tab': leafLayout('host-tab')
        }
      },
      () => false
    )

    const saved = store.getWorkspaceSession(HOST_ID)
    expect(saved.tabsByWorktree[WORKTREE_ID]?.map((row) => row.id)).toEqual([
      'main-tab',
      'host-tab'
    ])
  })
})

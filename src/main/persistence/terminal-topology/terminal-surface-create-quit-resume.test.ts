import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalSurfaceCreateRequest } from '../../../shared/terminal-surface-create'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as WORKTREE,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<string, (event: { returnValue?: unknown }, ...args: unknown[]) => void>(),
  invokeHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (
      channel: string,
      handler: (event: { returnValue?: unknown }, ...args: unknown[]) => void
    ) => syncHandlers.set(channel, handler),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      invokeHandlers.set(channel, handler)
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

import { registerRendererShutdownCheckpointHandler } from '../../ipc/renderer-shutdown-checkpoint'
import { registerSessionHandlers } from '../../ipc/session'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'

// A tab or pane the window creates is main's from creation, so it outlives a spawn that fails,
// never starts, or waits on an SSH connection, through quit and relaunch.

const SSH_WORKTREE = 'repo-remote::/fixture/remote'
const SSH_HOST: ExecutionHostId = 'ssh:build-host'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'

const directories: string[] = []

afterEach(() => {
  syncHandlers.clear()
  invokeHandlers.clear()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function row(id: string, worktreeId: string, customTitle: string | null = null): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Terminal 1',
    defaultTitle: 'Terminal 1',
    customTitle,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

async function windowOnStore() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-surface-create-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  registerSessionHandlers(store, new OrcaRuntimeService(store))
  registerRendererShutdownCheckpointHandler(store)
  return {
    directory,
    store,
    create: (request: TerminalSurfaceCreateRequest) =>
      invokeHandlers.get('session:terminal-create-surface')!({}, request),
    /** The window's quit: its session as it shows it, staged over main's topology. */
    stageQuit: (state: WorkspaceSessionState, hostId?: ExecutionHostId) => {
      const event: { returnValue?: unknown } = {}
      syncHandlers.get('app:stage-before-unload-sync')!(event, {
        sessions: [{ state: structuredClone(state), ...(hostId ? { hostId } : {}) }],
        ui: {}
      })
      return event.returnValue
    }
  }
}

function newTab(worktreeId: string, tab: TerminalTab, leafId?: string) {
  return {
    worktreeId,
    tabId: tab.id,
    ...(leafId ? { leafId } : {}),
    placement: { kind: 'new-tab' as const, row: { title: tab.title, createdAt: tab.createdAt } }
  }
}

describe('a tab or pane the window creates, quit before it binds', () => {
  it('keeps a background worktree’s default tabs, never mounted, and their applied mark', async () => {
    const { directory, store, create, stageQuit } = await windowOnStore()
    const tabs = [row('tab-default-1', WORKTREE, 'renamed'), row('tab-default-2', WORKTREE)]
    for (const tab of tabs) {
      await expect(create(newTab(WORKTREE, tab))).resolves.toMatchObject({ status: 'committed' })
    }
    const window = structuredClone(store.getWorkspaceSession())
    window.tabsByWorktree = { [WORKTREE]: tabs }
    window.defaultTerminalTabsAppliedByWorktreeId = { [WORKTREE]: true }
    expect(stageQuit(window)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const session = relaunched.getWorkspaceSession()
      expect(session.tabsByWorktree[WORKTREE]?.map((tab) => [tab.id, tab.customTitle])).toEqual([
        ['tab-default-1', 'renamed'],
        ['tab-default-2', null]
      ])
      expect(session.defaultTerminalTabsAppliedByWorktreeId?.[WORKTREE]).toBe(true)
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps a split whose spawn failed, with its title, and a later spawn only binds it', async () => {
    const { directory, store, create, stageQuit } = await windowOnStore()
    const tab = row('tab-split', WORKTREE)
    // The tab first, then its first pane once it mounts.
    await create(newTab(WORKTREE, tab))
    await create(newTab(WORKTREE, tab, LEFT))
    const split = {
      worktreeId: WORKTREE,
      tabId: tab.id,
      leafId: RIGHT,
      placement: { kind: 'split' as const, parentLeafId: LEFT, direction: 'horizontal' as const }
    }
    await expect(create(split)).resolves.toMatchObject({ status: 'committed' })
    // Idempotent: the same creation again changes nothing.
    const before = structuredClone(store.getWorkspaceSession())
    await expect(create(split)).resolves.toMatchObject({ status: 'committed' })
    expect(store.getWorkspaceSession()).toEqual(before)

    const window = structuredClone(store.getWorkspaceSession())
    window.terminalLayoutsByTabId[tab.id] = {
      ...window.terminalLayoutsByTabId[tab.id],
      titlesByLeafId: { [RIGHT]: 'build watch' }
    }
    expect(stageQuit(window)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const expectedRoot = {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEFT },
        second: { type: 'leaf', leafId: RIGHT }
      }
      const layout = relaunched.getWorkspaceSession().terminalLayoutsByTabId[tab.id]
      expect(layout?.root).toEqual(expectedRoot)
      expect(layout?.titlesByLeafId).toEqual({ [RIGHT]: 'build watch' })

      // The spawn's placement for a pane main already holds only binds it.
      await expect(
        relaunched.persistPtyBinding({
          worktreeId: WORKTREE,
          tabId: tab.id,
          leafId: RIGHT,
          ptyId: 'pty-right',
          placement: split.placement
        })
      ).resolves.toBe(true)
      const bound = relaunched.getWorkspaceSession().terminalLayoutsByTabId[tab.id]
      expect(bound?.root).toEqual(expectedRoot)
      expect(bound?.ptyIdsByLeafId).toEqual({ [RIGHT]: 'pty-right' })
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps an SSH pane waiting for its connection, in the SSH host’s partition', async () => {
    const { directory, store, create, stageQuit } = await windowOnStore()
    const tab = row('tab-ssh', SSH_WORKTREE)
    await expect(create(newTab(SSH_WORKTREE, tab, LEFT))).resolves.toMatchObject({
      status: 'committed'
    })
    expect(stageQuit(store.getWorkspaceSession(SSH_HOST), SSH_HOST)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const session = relaunched.getWorkspaceSession(SSH_HOST)
      expect(session.tabsByWorktree[SSH_WORKTREE]?.map((entry) => entry.id)).toEqual([tab.id])
      expect(session.terminalLayoutsByTabId[tab.id]?.root).toEqual({ type: 'leaf', leafId: LEFT })
      expect(relaunched.getWorkspaceSession().tabsByWorktree[SSH_WORKTREE]).toBeUndefined()
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps an agent launch tab, its agent and its laid-out pane, before the agent exists', async () => {
    const { directory, store, create, stageQuit } = await windowOnStore()
    const tab: TerminalTab = { ...row('tab-launch', WORKTREE), launchAgent: 'claude' }
    // The request a published launch tab sends: its host ids and the launch in the row.
    await expect(
      create({
        worktreeId: WORKTREE,
        tabId: tab.id,
        leafId: LEFT,
        placement: {
          kind: 'new-tab',
          row: { title: tab.title, createdAt: tab.createdAt, launchAgent: 'claude' }
        }
      })
    ).resolves.toMatchObject({ status: 'committed' })
    const window = structuredClone(store.getWorkspaceSession())
    window.tabsByWorktree = { [WORKTREE]: [{ ...tab, agentLaunchPane: { leafId: LEFT } }] }
    expect(stageQuit(window)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const session = relaunched.getWorkspaceSession()
      expect(session.tabsByWorktree[WORKTREE]).toEqual([
        expect.objectContaining({
          id: tab.id,
          ptyId: null,
          launchAgent: 'claude',
          agentLaunchPane: { leafId: LEFT }
        })
      ])
      expect(session.terminalLayoutsByTabId[tab.id]?.root).toEqual({ type: 'leaf', leafId: LEFT })
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps a tab adopted for a live PTY whose pane has not mounted', async () => {
    const { directory, store, create, stageQuit } = await windowOnStore()
    const tab: TerminalTab = { ...row('tab-adopted', WORKTREE), ptyId: 'pty-live' }
    await expect(create(newTab(WORKTREE, tab, LEFT))).resolves.toMatchObject({
      status: 'committed'
    })
    const window = structuredClone(store.getWorkspaceSession())
    window.tabsByWorktree = { [WORKTREE]: [tab] }
    expect(stageQuit(window)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const session = relaunched.getWorkspaceSession()
      expect(session.tabsByWorktree[WORKTREE]?.map((entry) => entry.id)).toEqual([tab.id])
      expect(session.terminalLayoutsByTabId[tab.id]?.root).toEqual({ type: 'leaf', leafId: LEFT })
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps a floating terminal tab, which no repo catalogs, in the local partition', async () => {
    const { directory, store, create, stageQuit } = await windowOnStore()
    const tab = row('tab-floating', FLOATING_TERMINAL_WORKTREE_ID, 'scratch')
    await expect(create(newTab(FLOATING_TERMINAL_WORKTREE_ID, tab, LEFT))).resolves.toMatchObject({
      status: 'committed'
    })
    const window = structuredClone(store.getWorkspaceSession())
    window.tabsByWorktree = { [FLOATING_TERMINAL_WORKTREE_ID]: [tab] }
    expect(stageQuit(window)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const session = relaunched.getWorkspaceSession()
      expect(
        session.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.map((entry) => [
          entry.id,
          entry.customTitle
        ])
      ).toEqual([[tab.id, 'scratch']])
      expect(session.terminalLayoutsByTabId[tab.id]?.root).toEqual({ type: 'leaf', leafId: LEFT })
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('refuses a tab main recorded as closed, and a split of a pane it does not hold', async () => {
    const { store, create } = await windowOnStore()
    const tab = row('tab-closed', WORKTREE)
    await create(newTab(WORKTREE, tab, LEFT))
    await invokeHandlers.get('session:close-terminal-surface')!(
      {},
      { worktreeId: WORKTREE, target: { kind: 'tab', tabId: tab.id } }
    )
    await expect(create(newTab(WORKTREE, tab, LEFT))).resolves.toMatchObject({
      status: 'refused',
      reason: 'tab_not_held'
    })
    const open = row('tab-open', WORKTREE)
    await create(newTab(WORKTREE, open, LEFT))
    await expect(
      create({
        worktreeId: WORKTREE,
        tabId: open.id,
        leafId: RIGHT,
        placement: { kind: 'split', parentLeafId: RIGHT, direction: 'vertical' }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'parent_missing' })
    expect(store.getWorkspaceSession().tabsByWorktree[WORKTREE]?.map((entry) => entry.id)).toEqual([
      open.id
    ])
  })
})

describe('a tab a phone closes on the desktop', () => {
  // The window commits the close, then saves its whole session before answering the phone.
  it('stays closed through the window’s full save and a relaunch, keeping the rest', async () => {
    const { directory, store, create } = await windowOnStore()
    const kept = row('tab-kept', WORKTREE)
    const closed = row('tab-closed', WORKTREE)
    await create(newTab(WORKTREE, kept, LEFT))
    await create(newTab(WORKTREE, closed, RIGHT))
    const before = structuredClone(store.getWorkspaceSession())

    const close = invokeHandlers.get('session:close-terminal-surface')!(
      {},
      { worktreeId: WORKTREE, target: { kind: 'tab', tabId: closed.id } }
    )
    // A debounced save taken before the close races it; the full save follows.
    await invokeHandlers.get('session:set')!({}, before)
    const window = structuredClone(before)
    window.tabsByWorktree = { [WORKTREE]: [{ ...kept, customTitle: 'server' }] }
    await invokeHandlers.get('session:set')!({}, window)
    await close

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const session = relaunched.getWorkspaceSession()
      expect(session.tabsByWorktree[WORKTREE]?.map((tab) => [tab.id, tab.customTitle])).toEqual([
        [kept.id, 'server']
      ])
      expect(session.terminalLayoutsByTabId[closed.id]).toBeUndefined()
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })
})

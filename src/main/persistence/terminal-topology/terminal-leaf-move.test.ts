import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { makeRepo } from '../../persistence-test-harness'
import { collectLayoutLeafIdsInOrder } from '../restoring-sessions/terminal-layout-normalization'
import {
  closeMoveTestStores,
  FROM,
  LEFT,
  MOVED,
  moveRequest,
  newDataFile,
  openStore,
  ownersOf,
  seedSplitSource,
  sleeping,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  TO,
  WT
} from './terminal-leaf-move-fixture'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

afterEach(closeMoveTestStores)

describe('moving a pane to a new tab', () => {
  it('moves the leaf and its binding in one write and re-keys pane-keyed records', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: { [FROM]: sleeping(FROM, SOURCE) }
    })
    store.updateUI({
      acknowledgedAgentsByPaneKey: { [FROM]: 10 },
      activityClearedAtByPaneKey: { [FROM]: 11 },
      manuallyUnreadTurnsByPaneKey: { [FROM]: 12 }
    })

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'moved', ptyId: 'pty-agent' })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([SOURCE, TARGET])
    expect(session.terminalLayoutsByTabId[SOURCE]).toMatchObject({
      root: { type: 'leaf', leafId: LEFT },
      ptyIdsByLeafId: { [LEFT]: 'pty-left' }
    })
    expect(session.terminalLayoutsByTabId[TARGET]).toMatchObject({
      root: { type: 'leaf', leafId: MOVED },
      ptyIdsByLeafId: { [MOVED]: 'pty-agent' }
    })
    expect(session.terminalPtyIncarnationsByPaneKey).toEqual({
      [`${SOURCE}:${LEFT}`]: 'inc-left',
      [TO]: 'inc-1'
    })
    expect(session.sleepingAgentSessionsByPaneKey).toEqual({
      [TO]: expect.objectContaining({ paneKey: TO, tabId: TARGET })
    })
    expect(store.getUI()).toMatchObject({
      acknowledgedAgentsByPaneKey: { [TO]: 10 },
      activityClearedAtByPaneKey: { [TO]: 11 },
      manuallyUnreadTurnsByPaneKey: { [TO]: 12 }
    })
    expect(ownersOf(session, 'pty-agent')).toEqual([TO])
  })

  it('re-keys the SSH lease and moves within the partition that holds the tab', async () => {
    const store = openStore(newDataFile())
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'pty-agent',
      worktreeId: WT,
      tabId: SOURCE,
      leafId: MOVED,
      state: 'attached'
    })

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toMatchObject({ status: 'moved' })

    expect(tabsHoldingLeaf(store.getWorkspaceSession(hostId), MOVED)).toEqual([TARGET])
    expect(store.getWorkspaceSession().tabsByWorktree[WT]).toBeUndefined()
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'pty-agent', tabId: TARGET, leafId: MOVED })
    ])
  })

  it('reports a leaf main never held instead of inventing one', async () => {
    const store = openStore(newDataFile())
    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'not_held' })
    expect(store.getWorkspaceSession().tabsByWorktree[WT]).toBeUndefined()
  })

  it('refuses a move that names another terminal or an existing tab', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-other' })
    ).resolves.toEqual({ status: 'refused', reason: 'pty_mismatch' })
    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, targetTabId: SOURCE, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'refused', reason: 'invalid_request' })
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([SOURCE])
  })
})

// Review S6: the renderer could not apply a move main committed, so it asks main to put it back.
describe('putting back a committed move', () => {
  it('returns the leaf, binding and pane-keyed records to the source tab in every partition', async () => {
    const store = openStore(newDataFile())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' }
    await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'relay_reattach' })
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'pty-agent',
      worktreeId: WT,
      tabId: SOURCE,
      leafId: MOVED,
      state: 'attached'
    })
    store.updateUI({ acknowledgedAgentsByPaneKey: { [FROM]: 10 } })
    const request = { ...moveRequest, ptyId: 'pty-agent' }
    await store.moveTerminalLeafToNewTab(request)

    await expect(store.moveTerminalLeafToNewTab({ ...request, undo: true })).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-agent'
    })

    for (const session of [store.getWorkspaceSession(hostId), store.getWorkspaceSession()]) {
      expect(tabsHoldingLeaf(session, MOVED)).toEqual([SOURCE])
      expect(ownersOf(session, 'pty-agent')).toEqual([FROM])
      expect(session.tabsByWorktree[WT]?.map((tab) => tab.id)).not.toContain(TARGET)
      expect(session.terminalPtyIncarnationsByPaneKey?.[FROM]).toBe('inc-1')
    }
    expect(store.getUI().acknowledgedAgentsByPaneKey).toEqual({ [FROM]: 10 })
    expect(store.getSshRemotePtyLeases('ssh-1')).toEqual([
      expect.objectContaining({ ptyId: 'pty-agent', tabId: SOURCE, leafId: MOVED })
    ])
    expect(
      await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'reattach' }, hostId)
    ).toBe(true)
  })

  it('leaves a target tab alone once it holds more than the moved leaf', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    const request = { ...moveRequest, ptyId: 'pty-agent' }
    await store.moveTerminalLeafToNewTab(request)
    await store.persistPtyBinding({
      worktreeId: WT,
      tabId: TARGET,
      leafId: '33333333-3333-4333-8333-333333333333',
      ptyId: 'pty-third',
      incarnationId: 'inc-3'
    })
    expect(
      collectLayoutLeafIdsInOrder(store.getWorkspaceSession().terminalLayoutsByTabId[TARGET]!.root)
    ).toHaveLength(2)

    // Review-2 N2: reported, not a silent not_held.
    await expect(store.moveTerminalLeafToNewTab({ ...request, undo: true })).resolves.toEqual({
      status: 'refused',
      reason: 'target_changed'
    })
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])
  })
})

// Review B1: after a restart the relay reattach writes the SSH pane into `local` as well as
// `ssh:`; a move that left either copy behind refused the moved pane and the next relay reattach.
describe('moving an SSH pane held by both partitions', () => {
  it('moves every copy, so the target reattach and the next relay reattach both bind', async () => {
    const store = openStore(newDataFile())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' }
    expect(
      await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'relay_reattach' })
    ).toBe(true)

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toMatchObject({ status: 'moved' })

    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(hostId), MOVED)).toEqual([TARGET])
    expect(
      await store.persistPtyBinding({ ...relay, tabId: TARGET, origin: 'reattach' }, hostId)
    ).toBe(true)
    expect(
      await store.persistPtyBinding({
        ...relay,
        tabId: TARGET,
        origin: 'relay_reattach',
        mayReviveRetiredSurface: false
      })
    ).toBe(true)
  })

  // Plan B1-2: relay reattach into local, move, target reattach in ssh:, next-start relay reattach.
  it('keeps one holder per partition across a restart, and the next relay reattach binds', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    const relay = { worktreeId: WT, leafId: MOVED, ptyId: 'pty-agent', incarnationId: 'inc-1' }
    await store.persistPtyBinding({ ...relay, tabId: SOURCE, origin: 'relay_reattach' })
    await store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    expect(
      await store.persistPtyBinding({ ...relay, tabId: TARGET, origin: 'reattach' }, hostId)
    ).toBe(true)
    store.flush()

    const restarted = openStore(dataFile)
    expect(
      await restarted.persistPtyBinding({
        ...relay,
        tabId: TARGET,
        origin: 'relay_reattach',
        mayReviveRetiredSurface: false
      })
    ).toBe(true)
    for (const session of [
      restarted.getWorkspaceSession(),
      restarted.getWorkspaceSession(hostId)
    ]) {
      expect(tabsHoldingLeaf(session, MOVED)).toEqual([TARGET])
      expect(ownersOf(session, 'pty-agent')).toEqual([TO])
    }
  })

  it('refuses a move while another tab already holds the leaf', async () => {
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    const session = store.getWorkspaceSession()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WT]: [
          ...(session.tabsByWorktree[WT] ?? []),
          { ...(session.tabsByWorktree[WT] ?? [])[0]!, id: 'tab-earlier-move' }
        ]
      },
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        'tab-earlier-move': {
          root: { type: 'leaf', leafId: MOVED },
          activeLeafId: MOVED,
          expandedLeafId: null
        }
      }
    })

    await expect(
      store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    ).resolves.toEqual({ status: 'refused', reason: 'leaf_in_other_tab' })
  })
})

// STA-9259: detach, then the moved pane's reattach binding, then a renderer snapshot that still
// shows the pre-move layout, then a restart. Before the move transaction this left one leaf and
// one PTY in both tabs.
describe('STA-9259 move sequence', () => {
  it('keeps one owner through reattach, a stale renderer save and a restart', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    // Load sweeps sessions of unregistered repos, so the restart needs a real owner.
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    await seedSplitSource(store)
    const preMoveRendererSnapshot = structuredClone(store.getWorkspaceSession())

    await store.moveTerminalLeafToNewTab({ ...moveRequest, ptyId: 'pty-agent' })
    // The moved pane mounts in the target tab and reattaches with its stable-owner fence.
    const reattached = await store.persistPtyBinding({
      worktreeId: WT,
      tabId: TARGET,
      leafId: MOVED,
      ptyId: 'pty-agent',
      incarnationId: 'inc-1',
      expectedBinding: { ptyId: 'pty-agent', incarnationId: 'inc-1' },
      origin: 'reattach'
    })
    expect(reattached).toBe(true)
    // A debounced renderer save that predates the move must not resurrect the source copy.
    store.setWorkspaceSession(preMoveRendererSnapshot)
    expect(ownersOf(store.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(store.getWorkspaceSession(), MOVED)).toEqual([TARGET])

    store.flush()
    const restarted = openStore(dataFile)
    expect(ownersOf(restarted.getWorkspaceSession(), 'pty-agent')).toEqual([TO])
    expect(tabsHoldingLeaf(restarted.getWorkspaceSession(), MOVED)).toEqual([TARGET])
  })
})

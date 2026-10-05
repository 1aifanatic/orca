import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { makeRepo, makeTerminalTab } from '../../persistence-test-harness'
import { planTerminalLeafMove } from './terminal-leaf-move'
import { planTerminalLeafMoveUndo } from './terminal-leaf-move-undo'
import {
  closeMoveTestStores,
  LEFT,
  MOVED,
  moveRequest,
  newDataFile,
  openStore,
  seedSplitSource,
  sleeping,
  SOURCE,
  TARGET,
  tabsHoldingLeaf,
  TO,
  WT
} from './terminal-leaf-move-fixture'
import { closeLeafOrTab } from './terminal-topology-commit'

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

afterEach(async () => {
  _resetTracerForTests()
  await closeMoveTestStores()
})

const THIRD = '33333333-3333-4333-8333-333333333333'
const request = { ...moveRequest, ptyId: 'pty-agent' }
const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })

function sourceSession(layouts: WorkspaceSessionState['terminalLayoutsByTabId']) {
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: WT,
    activeTabId: SOURCE,
    tabsByWorktree: {
      [WT]: [makeTerminalTab({ id: SOURCE, ptyId: 'pty-left', worktreeId: WT })]
    },
    terminalLayoutsByTabId: layouts
  } satisfies WorkspaceSessionState
}

// Review-2 SF1: the source tab closed while the move was in flight, then the renderer asked to undo.
describe('undo after the source tab closed', () => {
  it('retires the moved tab instead of leaving a ghost that returns on restart', async () => {
    const dataFile = newDataFile()
    const store = openStore(dataFile)
    store.addRepo(makeRepo({ id: 'repo-1', path: '/tmp/move-worktree' }))
    await seedSplitSource(store)
    store.setWorkspaceSession({
      ...store.getWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        [`${SOURCE}:${MOVED}`]: sleeping(`${SOURCE}:${MOVED}`, SOURCE)
      }
    })
    await store.moveTerminalLeafToNewTab(request)
    await store.runDurableMutation(
      closeLeafOrTab({
        worktreeId: WT,
        target: { kind: 'tab', tabId: SOURCE },
        options: { force: true, reason: 'user' },
        requestedSession: store.getWorkspaceSession(),
        ownerMatches: () => true,
        hostId: () => 'local',
        getSession: (hostId) => store.getWorkspaceSession(hostId),
        setSession: (session, hostId) => store.setWorkspaceSession(session, hostId),
        onClosed: () => {}
      })
    )

    await expect(store.moveTerminalLeafToNewTab({ ...request, undo: true })).resolves.toEqual({
      status: 'retired'
    })

    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[WT] ?? []).toEqual([])
    expect(session.terminalLayoutsByTabId[TARGET]).toBeUndefined()
    expect(session.terminalPtyIncarnationsByPaneKey?.[TO]).toBeUndefined()
    expect(session.sleepingAgentSessionsByPaneKey?.[TO]).toBeUndefined()
    store.flush()
    const restarted = openStore(dataFile).getWorkspaceSession()
    expect(restarted.tabsByWorktree[WT] ?? []).toEqual([])
    expect(tabsHoldingLeaf(restarted, MOVED)).toEqual([])
  })
})

// Review-2 SF2: an undo puts the leaf back where it was, not appended as a horizontal split.
describe('undo restores the original placement', () => {
  const original: TerminalPaneLayoutNode = {
    type: 'split',
    direction: 'vertical',
    ratio: 0.3,
    first: leaf(MOVED),
    second: { type: 'split', direction: 'horizontal', first: leaf(LEFT), second: leaf(THIRD) }
  }

  it('restores direction, ratio, position, tab PTY and the SSH remote session id', async () => {
    const store = openStore(newDataFile())
    const hostId = toSshExecutionHostId('ssh-1')
    await seedSplitSource(store, hostId)
    await store.persistPtyBinding(
      { worktreeId: WT, tabId: SOURCE, leafId: THIRD, ptyId: 'pty-third', incarnationId: 'i3' },
      hostId
    )
    const seeded = store.getWorkspaceSession(hostId)
    store.setWorkspaceSession(
      {
        ...seeded,
        tabsByWorktree: {
          [WT]: seeded.tabsByWorktree[WT]!.map((tab) => ({ ...tab, ptyId: 'pty-agent' }))
        },
        terminalLayoutsByTabId: {
          [SOURCE]: { ...seeded.terminalLayoutsByTabId[SOURCE]!, root: original }
        },
        remoteSessionIdsByTabId: { [SOURCE]: 'pty-agent' }
      },
      hostId
    )

    await store.moveTerminalLeafToNewTab(request)
    expect(store.getWorkspaceSession(hostId).remoteSessionIdsByTabId?.[SOURCE]).not.toBe(
      'pty-agent'
    )
    await expect(store.moveTerminalLeafToNewTab({ ...request, undo: true })).resolves.toEqual({
      status: 'moved',
      ptyId: 'pty-agent'
    })

    const session = store.getWorkspaceSession(hostId)
    expect(session.terminalLayoutsByTabId[SOURCE]?.root).toEqual(original)
    expect(session.remoteSessionIdsByTabId).toEqual({ [SOURCE]: 'pty-agent' })
    expect(session.tabsByWorktree[WT]?.map((tab) => [tab.id, tab.ptyId])).toEqual([
      [SOURCE, 'pty-agent']
    ])
  })

  it('never adds a second copy when the source already holds the leaf again', () => {
    const moved = planTerminalLeafMove(
      [
        {
          hostId: 'local',
          session: sourceSession({
            [SOURCE]: { root: original, activeLeafId: LEFT, expandedLeafId: null }
          })
        }
      ],
      request
    )
    const after = moved.sessions[0]!.session
    const resaved = {
      ...after,
      terminalLayoutsByTabId: {
        ...after.terminalLayoutsByTabId,
        [SOURCE]: { root: original, activeLeafId: LEFT, expandedLeafId: null }
      }
    }

    const undone = planTerminalLeafMoveUndo(
      [{ hostId: 'local', session: resaved }],
      { ...request, undo: true },
      moved.origins
    )

    expect(undone.sessions[0]!.session.terminalLayoutsByTabId[SOURCE]?.root).toEqual(original)
  })
})

// Review-2 N1: a layout whose tab row is gone owns nothing, so it must not refuse a move.
it('moves a leaf that a stray layout of a removed tab still names', () => {
  const planned = planTerminalLeafMove(
    [
      {
        hostId: 'local',
        session: sourceSession({
          [SOURCE]: {
            root: { type: 'split', direction: 'vertical', first: leaf(LEFT), second: leaf(MOVED) },
            activeLeafId: LEFT,
            expandedLeafId: null
          },
          'tab-removed': { root: leaf(MOVED), activeLeafId: MOVED, expandedLeafId: null }
        })
      }
    ],
    request
  )
  expect(planned.result).toEqual({ status: 'moved', ptyId: 'pty-agent' })
})

describe('persistence.terminal-topology span for a move', () => {
  it('records the move and its undo without pane keys or PTY ids', async () => {
    const records: { name: string; attributes: Record<string, unknown> }[] = []
    setActiveSink({
      push: (record) => {
        records.push(JSON.parse(JSON.stringify(record)))
      },
      flush: () => {},
      close: () => {}
    })
    const store = openStore(newDataFile())
    await seedSplitSource(store)
    records.length = 0

    await store.moveTerminalLeafToNewTab(request)
    await store.moveTerminalLeafToNewTab({ ...request, undo: true })
    await store.moveTerminalLeafToNewTab({ ...request, ptyId: 'pty-other' })

    const spans = records.filter((record) => record.name === 'persistence.terminal-topology')
    expect(spans.map((span) => span.attributes)).toEqual([
      { kind: 'persistence', 'topology.kind': 'move_leaf', 'topology.outcome': 'committed' },
      { kind: 'persistence', 'topology.kind': 'undo_move_leaf', 'topology.outcome': 'committed' },
      {
        kind: 'persistence',
        'topology.kind': 'move_leaf',
        'topology.outcome': 'refused',
        'topology.refusal': 'pty_mismatch'
      }
    ])
    expect(JSON.stringify(spans)).not.toMatch(/pty-|tab-source|tab-target|2222/)
  })
})

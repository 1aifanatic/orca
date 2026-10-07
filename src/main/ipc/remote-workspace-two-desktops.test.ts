/**
 * Blocking (plan §4.1a "SSH no export loop"): two desktops share one relay. An import, and the
 * window's save-back of what it applied, export nothing; a local split on either desktop exports
 * exactly once; a conflicted import keeps that desktop out of exports.
 *
 * Each desktop is its own module graph (own snapshot cache, patch queue and CLIENT_ID), as two
 * processes would be. The relay is an in-memory workspace with revisions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { importRemoteWorkspaceSession } from '../../shared/remote-workspace-session-projection'
import type * as RemoteWorkspaceModule from './remote-workspace'
import type * as ExportDriverModule from './remote-workspace-export-test-driver'

type Relay = {
  revision: number
  session: RemoteWorkspaceSession
  patches: { clientId: string; baseRevision: number }[]
  listeners: ((snapshot: RemoteWorkspaceSnapshot, clientId: string) => void)[]
}

const { relay } = vi.hoisted(() => {
  const relay: Relay = {
    revision: 0,
    session: {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: {},
      terminalLayoutsByTabId: {}
    },
    patches: [],
    listeners: []
  }
  return { relay }
})

const TARGET: SshTarget = {
  id: 'target-1',
  label: 'Build box',
  host: 'build.example.com',
  port: 22,
  username: 'dev'
}
const WORKTREE_PATH = '/srv/app'
const WORKTREE_ID = `repo-1::${WORKTREE_PATH}`

type RelayPatchParams = {
  baseRevision: number
  clientId: string
  patch: { session: RemoteWorkspaceSession }
}

function relaySnapshot(): RemoteWorkspaceSnapshot {
  return {
    namespace: 'workspace',
    revision: relay.revision,
    updatedAt: relay.revision,
    schemaVersion: 1,
    session: structuredClone(relay.session)
  }
}

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }
}))
vi.mock('./remote-workspace-events', () => ({
  registerRemoteWorkspaceNotificationHandler: () => () => {}
}))
vi.mock('./ssh', () => ({
  getSshConnectionStore: () => ({
    listTargets: () => [TARGET],
    getTarget: () => TARGET
  }),
  getActiveMultiplexer: () => ({
    request: async (method: string, { baseRevision, clientId, patch }: RelayPatchParams) => {
      if (method === 'workspace.get') {
        return relaySnapshot()
      }
      relay.patches.push({ clientId, baseRevision })
      if (baseRevision !== relay.revision) {
        return {
          ok: false,
          reason: 'stale-revision',
          snapshot: relaySnapshot()
        }
      }
      relay.revision += 1
      relay.session = structuredClone(patch.session)
      const snapshot = relaySnapshot()
      for (const listener of relay.listeners) {
        listener(snapshot, clientId)
      }
      return { ok: true, snapshot }
    }
  })
}))

type Desktop = {
  driver: ExportDriverModule.RemoteWorkspaceExportDriver
  clientId: string
  /** Set to make this desktop's next imports conflicted (unplaceable host tabs). */
  conflicted: boolean
  imports: number
}

function tab(id: string): WorkspaceSessionState['tabsByWorktree'][string][number] {
  return {
    id,
    ptyId: null,
    worktreeId: WORKTREE_ID,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function withSplit(
  session: WorkspaceSessionState,
  tabId: string,
  direction: 'vertical' | 'horizontal' = 'vertical'
): WorkspaceSessionState {
  return {
    ...session,
    terminalLayoutsByTabId: {
      ...session.terminalLayoutsByTabId,
      [tabId]: {
        root: {
          type: 'split',
          direction,
          first: { type: 'leaf', leafId: `${tabId}-a` },
          second: { type: 'leaf', leafId: `${tabId}-b` }
        },
        activeLeafId: `${tabId}-a`,
        expandedLeafId: null
      }
    }
  }
}

async function bootDesktop(): Promise<Desktop> {
  vi.resetModules()
  const remoteWorkspace: typeof RemoteWorkspaceModule = await import('./remote-workspace')
  const { CLIENT_ID } = await import('./remote-workspace-client-identity')
  const remoteWorkspaceCache = await import('./remote-workspace-snapshot-cache')
  const { createRemoteWorkspaceExportDriver }: typeof ExportDriverModule =
    await import('./remote-workspace-export-test-driver')
  remoteWorkspace._resetRemoteWorkspaceCachesForTests()
  const repo: Repo = {
    id: 'repo-1',
    path: '/srv',
    displayName: 'app',
    badgeColor: 'blue',
    addedAt: 1,
    connectionId: TARGET.id
  }
  const desktop: Desktop = {
    clientId: CLIENT_ID,
    conflicted: false,
    imports: 0,
    // The window's importer: today's projection of the host snapshot, committed through main,
    // then saved back once the window has applied it.
    driver: createRemoteWorkspaceExportDriver(
      { getRepos: () => [repo] },
      (event: RemoteWorkspaceChangedEvent) => {
        if (event.sourceClientId === CLIENT_ID) {
          return
        }
        const imported = importRemoteWorkspaceSession(event.snapshot.session, {
          resolveWorktreeId: (path) => (path === WORKTREE_PATH ? WORKTREE_ID : null),
          executionHostId: `ssh:${TARGET.id}`
        })
        const patch = {
          tabsByWorktree: imported.tabsByWorktree,
          terminalLayoutsByTabId: imported.terminalLayoutsByTabId
        }
        desktop.imports += 1
        desktop.driver.importPeer({
          targetId: TARGET.id,
          revision: event.snapshot.revision,
          hostObservationToken: event.snapshot.hostObservationToken,
          outcome: desktop.conflicted ? 'conflict' : 'synced',
          patches: [{ hostId: `ssh:${TARGET.id}`, patch }]
        })
        desktop.driver.write(patch)
      }
    )
  }
  relay.listeners.push((snapshot, sourceClientId) =>
    remoteWorkspace.handleRemoteWorkspaceNotification(TARGET.id, 'workspace.changed', {
      snapshot,
      sourceClientId
    })
  )
  // Connect: the window pulls and agrees with the host.
  await desktop.driver.handlers.get('remoteWorkspace:get')?.(null, { targetId: TARGET.id })
  const observed = remoteWorkspaceCache.getCachedRemoteWorkspaceSnapshot(TARGET.id)
  if (!observed) {
    throw new Error('connect did not observe the host')
  }
  desktop.driver.agree(TARGET.id, observed)
  return desktop
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('two desktops, one relay', () => {
  let a: Desktop
  let b: Desktop

  beforeEach(async () => {
    relay.revision = 3
    relay.session = {
      activeWorktreePath: null,
      activeTabId: null,
      tabsByWorktreePath: { [WORKTREE_PATH]: [] },
      terminalLayoutsByTabId: {}
    }
    relay.patches = []
    relay.listeners = []
    a = await bootDesktop()
    b = await bootDesktop()
    await settle()
  })

  it('exports a local split once, and the peer import plus its save-back exports nothing', async () => {
    expect(relay.patches).toEqual([])

    a.driver.write(
      withSplit(
        {
          ...a.driver.readSession(),
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-a')] }
        },
        'tab-a'
      )
    )
    await settle()

    expect(relay.patches).toEqual([{ clientId: a.clientId, baseRevision: 3 }])
    expect(b.imports).toBe(1)

    b.driver.write(withSplit(b.driver.readSession(), 'tab-a', 'horizontal'))
    await settle()

    expect(relay.patches).toEqual([
      { clientId: a.clientId, baseRevision: 3 },
      { clientId: b.clientId, baseRevision: 4 }
    ])
    expect(a.imports).toBe(1)
    expect(relay.revision).toBe(5)
  })

  it('keeps a desktop whose import conflicted out of exports', async () => {
    b.conflicted = true
    a.driver.write(
      withSplit(
        {
          ...a.driver.readSession(),
          tabsByWorktree: { [WORKTREE_ID]: [tab('tab-a')] }
        },
        'tab-a'
      )
    )
    await settle()
    expect(b.imports).toBe(1)

    b.driver.write(withSplit(b.driver.readSession(), 'tab-a', 'horizontal'))
    await settle()

    expect(relay.patches).toEqual([{ clientId: a.clientId, baseRevision: 3 }])
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { TerminalTopologySlice } from '../../../shared/terminal-topology-slice'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Store } from '../loading-store/store'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID as WORKTREE,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'
import { sleepLeaf, wakeLeaf } from './terminal-topology-commit'

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<string, (event: { returnValue?: unknown }, args: unknown) => void>(),
  invokeHandlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, handler: (event: { returnValue?: unknown }, args: unknown) => void) =>
      syncHandlers.set(channel, handler),
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
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
import type { RuntimeNotifier } from '../../runtime/runtime-notifier-contract'

const TAB = 'tab-agent'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB}:${LEAF}`
const OTHER_PANE_KEY = `tab-elsewhere:${LEAF}`

const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.freezeWritesAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  syncHandlers.clear()
  invokeHandlers.clear()
})

function record(paneKey: string, capturedAt: number): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${capturedAt}` },
    prompt: 'finish the task',
    state: 'waiting',
    capturedAt,
    updatedAt: capturedAt,
    origin: 'worktree-sleep'
  }
}

function sessionWithAgentTab(session: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: TAB,
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'codex',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB]: { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    }
  }
}

function notifier(pushes: TerminalTopologySlice[]): RuntimeNotifier {
  const ignore = (): void => {}
  return {
    worktreesChanged: ignore,
    reposChanged: ignore,
    activateWorktree: ignore,
    createTerminal: ignore,
    splitTerminal: ignore,
    renameTerminal: ignore,
    focusTerminal: ignore,
    closeTerminal: ignore,
    sleepWorktree: ignore,
    terminalFitOverrideChanged: ignore,
    terminalDriverChanged: ignore,
    terminalTopologyChanged: (slice) => pushes.push(slice)
  }
}

/** A real store holding the agent's tab, main's IPC handlers, and the pushes main publishes. */
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sleep-wake-commit-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  stores.push(store)
  store.setWorkspaceSession(sessionWithAgentTab(store.getWorkspaceSession()))
  const runtime = new OrcaRuntimeService(store)
  const pushes: TerminalTopologySlice[] = []
  runtime.setNotifier(notifier(pushes))
  runtime.getTerminalTopologySlices()
  registerSessionHandlers(store, runtime)
  registerRendererShutdownCheckpointHandler(store)
  const invoke = (channel: string, args: unknown): unknown => invokeHandlers.get(channel)!({}, args)
  const nextPush = async (): Promise<TerminalTopologySlice | undefined> => {
    pushes.length = 0
    await Promise.resolve()
    return pushes.find((slice) => slice.worktreeId === WORKTREE)
  }
  return { directory, store, invoke, nextPush }
}

describe('sleepLeaf and wakeLeaf', () => {
  const session = sessionWithAgentTab(getDefaultWorkspaceSession())

  it('a partition takes only the records whose tab it holds', () => {
    const next = sleepLeaf(session, {
      [PANE_KEY]: record(PANE_KEY, 1),
      [OTHER_PANE_KEY]: record(OTHER_PANE_KEY, 1)
    })
    expect(next.sleepingAgentSessionsByPaneKey).toEqual({ [PANE_KEY]: record(PANE_KEY, 1) })
    expect(sleepLeaf(session, { [OTHER_PANE_KEY]: record(OTHER_PANE_KEY, 1) })).toBe(session)
  })

  it('an unchanged record or an absent wake leaves the session as it was', () => {
    const held = sleepLeaf(session, { [PANE_KEY]: record(PANE_KEY, 1) })
    expect(sleepLeaf(held, { [PANE_KEY]: record(PANE_KEY, 1) })).toBe(held)
    expect(wakeLeaf(held, [OTHER_PANE_KEY])).toBe(held)
    expect(wakeLeaf(held, [PANE_KEY]).sleepingAgentSessionsByPaneKey).toEqual({})
  })
})

describe('sleep and wake commits', () => {
  it('a sleep commit arrives in the next slice, and a wake removes it', async () => {
    const { invoke, nextPush } = await setup()

    invoke('session:terminal-sleep-leaves', { [PANE_KEY]: record(PANE_KEY, 1) })
    expect((await nextPush())?.sleeping).toEqual({ [PANE_KEY]: record(PANE_KEY, 1) })

    invoke('session:terminal-wake-leaves', [PANE_KEY])
    expect((await nextPush())?.sleeping).toEqual({})
  })

  it('drops a malformed record and a record whose tab main does not hold', async () => {
    const { store, invoke } = await setup()

    invoke('session:terminal-sleep-leaves', {
      [PANE_KEY]: { ...record(PANE_KEY, 1), agent: 'not-an-agent' },
      [OTHER_PANE_KEY]: record(OTHER_PANE_KEY, 1)
    })

    expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey ?? {}).toEqual({})
  })

  it('the quit stage commits sleep records before staging the session', async () => {
    const { directory, store } = await setup()
    const quitRecord = record(PANE_KEY, 2)
    const stage = store.stageWorkspaceSessionBeforeUnload.bind(store)
    let heldAtStage: SleepingAgentSessionRecord | undefined
    vi.spyOn(store, 'stageWorkspaceSessionBeforeUnload').mockImplementation((...args) => {
      heldAtStage = store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
      stage(...args)
    })
    // The window's session as it stages it today, quit capture included.
    const window = structuredClone(store.getWorkspaceSession())
    window.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: quitRecord }
    const event: { returnValue?: unknown } = {}

    syncHandlers.get('app:stage-before-unload-sync')!(event, {
      sessions: [{ state: window }],
      ui: {},
      sleepingRecords: { sleep: { [PANE_KEY]: quitRecord }, wake: [] }
    })

    expect(event.returnValue).toEqual({ ok: true })
    expect(heldAtStage).toEqual(quitRecord)
    stores.splice(stores.indexOf(store), 1)
    const relaunched = await reopenTopologyStore(store, directory)
    stores.push(relaunched)
    expect(relaunched.getWorkspaceSession().sleepingAgentSessionsByPaneKey).toEqual({
      [PANE_KEY]: quitRecord
    })
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { buildAgentResumeStartupPlan } from '../../../shared/tui-agent-resume-startup'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { projectTerminalTopologySlice } from '../../runtime/terminal-topology-projection'
import type { Store } from '../loading-store/store'
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

// Sleeping records are main's own commits and window saves are presentation-only; a slept agent
// must still be resumable after quit and relaunch.

const TAB = 'tab-agent'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = `${WORKTREE}@@0a1b2c3d`
const PANE_KEY = `${TAB}:${LEAF}`

const directories: string[] = []

afterEach(() => {
  syncHandlers.clear()
  invokeHandlers.clear()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function record(origin: 'worktree-sleep' | 'quit', capturedAt: number): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: TAB,
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id: `session-${capturedAt}` },
    prompt: 'finish the task',
    state: 'waiting',
    capturedAt,
    updatedAt: capturedAt,
    origin
  }
}

/** The window's session after it spawned an agent pane, as its debounced save sends it. */
function windowSessionWithAgentPane(store: Store): WorkspaceSessionState {
  const session = structuredClone(store.getWorkspaceSession())
  session.tabsByWorktree = {
    ...session.tabsByWorktree,
    [WORKTREE]: [
      {
        id: TAB,
        ptyId: PTY,
        worktreeId: WORKTREE,
        title: 'codex',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        launchAgent: 'codex'
      }
    ]
  }
  session.terminalLayoutsByTabId = {
    ...session.terminalLayoutsByTabId,
    [TAB]: {
      root: { type: 'leaf', leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF]: PTY }
    }
  }
  return session
}

/** The window's IPC into main: its own sleeping-record commits, its saves and its quit stage. */
function windowChannels(store: Store) {
  registerSessionHandlers(store, new OrcaRuntimeService(store))
  registerRendererShutdownCheckpointHandler(store)
  return {
    commitSleep: (held: SleepingAgentSessionRecord) =>
      invokeHandlers.get('session:commit-terminal-sleeping-records')!(
        {},
        { sleep: { [PANE_KEY]: held }, wake: [] }
      ),
    save: (session: WorkspaceSessionState) =>
      invokeHandlers.get('session:set')!({}, structuredClone(session)),
    stageQuit: (session: WorkspaceSessionState) => {
      const event: { returnValue?: unknown } = {}
      syncHandlers.get('app:stage-before-unload-sync')!(event, {
        sessions: [{ state: structuredClone(session) }],
        ui: {}
      })
      return event.returnValue
    }
  }
}

async function storeWithAgentPane() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-sleep-quit-resume-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = windowSessionWithAgentPane(store)
  // Main's own rows, as the spawn's placement wrote them.
  store.setWorkspaceSession(structuredClone(window))
  await expect(
    store.persistPtyBinding({ worktreeId: WORKTREE, tabId: TAB, leafId: LEAF, ptyId: PTY })
  ).resolves.toBe(true)
  return { directory, store, window, channels: windowChannels(store) }
}

/** What main holds for the slept pane, and what the window would show from its slice. */
function heldForPane(store: Store) {
  const session = store.getWorkspaceSession()
  const slice = projectTerminalTopologySlice(session, LOCAL_EXECUTION_HOST_ID, WORKTREE)
  return {
    record: session.sleepingAgentSessionsByPaneKey?.[PANE_KEY],
    sliceRecord: slice.sleeping[PANE_KEY],
    tabs: slice.tabs.map((tab) => tab.id),
    binding: slice.layouts[TAB]?.ptyIdsByLeafId?.[LEAF]
  }
}

function resumeCommand(held: SleepingAgentSessionRecord | undefined): string | undefined {
  return held
    ? buildAgentResumeStartupPlan({
        agent: held.agent,
        providerSession: held.providerSession,
        cmdOverrides: {},
        platform: 'linux'
      })?.launchCommand
    : undefined
}

describe('sleep → quit → resume', () => {
  it('keeps the quit capture over the periodic one through quit and relaunch', async () => {
    const { directory, store, window, channels } = await storeWithAgentPane()
    // The agent is slept; the periodic capture commits it and the window's save carries it too.
    channels.commitSleep(record('worktree-sleep', 1))
    window.sleepingAgentSessionsByPaneKey = { [PANE_KEY]: record('worktree-sleep', 1) }
    channels.save(window)
    // Quit: the quit capture commits, then the stage carries the window's older copy.
    channels.commitSleep(record('quit', 2))
    expect(channels.stageQuit(window)).toEqual({ ok: true })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      const expected = {
        record: record('quit', 2),
        sliceRecord: record('quit', 2),
        tabs: [TAB],
        binding: PTY
      }
      expect(heldForPane(relaunched)).toEqual(expected)
      // The relaunched window's first save is its hydrated copy; the record stays.
      windowChannels(relaunched).save(relaunched.getWorkspaceSession())
      expect(heldForPane(relaunched)).toEqual(expected)
      expect(resumeCommand(heldForPane(relaunched).record)).toBe("codex 'resume' 'session-2'")
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })

  it('keeps a committed record through a quit stage whose window copy has none', async () => {
    const { directory, store, window, channels } = await storeWithAgentPane()
    channels.commitSleep(record('quit', 3))
    channels.stageQuit({ ...window, sleepingAgentSessionsByPaneKey: {} })

    const relaunched = await reopenTopologyStore(store, directory)
    try {
      expect(heldForPane(relaunched)).toEqual({
        record: record('quit', 3),
        sliceRecord: record('quit', 3),
        tabs: [TAB],
        binding: PTY
      })
      expect(resumeCommand(heldForPane(relaunched).record)).toBe("codex 'resume' 'session-3'")
    } finally {
      await relaunched.freezeWritesAsync()
    }
  })
})

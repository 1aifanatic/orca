/**
 * A window document that lived through a host editor commit without being the editor authority
 * holds a stale editor view. Its session writes and unload checkpoint keep only unsaved drafts,
 * and its graph is never re-attached; normal writers are admitted exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

type IpcEvent = {
  sender?: { id: number; mainFrame: unknown }
  senderFrame?: unknown
  returnValue?: unknown
}

const { syncHandlers, invokeHandlers } = vi.hoisted(() => ({
  syncHandlers: new Map<string, (event: IpcEvent, ...args: unknown[]) => void>(),
  invokeHandlers: new Map<string, (event: IpcEvent, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: vi.fn((channel: string, handler: (event: IpcEvent, ...args: unknown[]) => void) => {
      syncHandlers.set(channel, handler)
    }),
    handle: vi.fn((channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown) => {
      invokeHandlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  ipcRenderer: {
    sendSync: vi.fn((channel: string, ...args: unknown[]) => {
      const event: IpcEvent = { sender: liveSender(), senderFrame: liveSender().mainFrame }
      syncHandlers.get(channel)?.(event, ...args)
      return event.returnValue
    })
  }
}))

// Why: the real preload checkpoint bridge decides unload from the reply; only its window wiring is stubbed.
vi.mock('../../preload/preload-runtime-support', () => ({
  awaitBeforeUnloadCheckpoint: vi.fn(),
  startupDiagnosticsEnabled: () => false
}))
vi.mock('../../preload/renderer-restart-wiring', () => ({ prepareAndInvokeAppRestart: vi.fn() }))

import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'
import { registerSessionHandlers } from './session'
import { obsoleteWindowDocuments } from '../window/obsolete-window-documents'

const WEB_CONTENTS_ID = 7
const MAIN_FRAME = { frame: 'main' }
const WT = 'repo-1::/work'
function liveSender(): { id: number; mainFrame: unknown } {
  return { id: WEB_CONTENTS_ID, mainFrame: MAIN_FRAME }
}

function session(rows: WorkspaceSessionState['openFilesByWorktree']): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: rows
  }
}

function row(filePath: string, extra: Record<string, unknown> = {}) {
  return {
    filePath,
    relativePath: filePath.slice(1),
    worktreeId: WT,
    language: 'markdown',
    ...extra
  }
}

function createStore(initial: Record<string, WorkspaceSessionState>) {
  const sessions = new Map(Object.entries(initial))
  const store = {
    getWorkspaceSession: vi.fn((hostId?: string | null) => sessions.get(hostId ?? 'local')!),
    setWorkspaceSession: vi.fn((next: WorkspaceSessionState, hostId?: string | null) => {
      sessions.set(hostId ?? 'local', next)
    }),
    patchWorkspaceSession: vi.fn(),
    stageWorkspaceSessionBeforeUnload: vi.fn(),
    updateUI: vi.fn(),
    flushPendingOrThrowAsync: vi.fn(async () => {})
  }
  return { store, sessions }
}

type FakeStore = ReturnType<typeof createStore>['store']

function registerSession(store: FakeStore): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test call only the session/flush methods FakeStore implements; the runtime is unused by them.
  registerSessionHandlers(store as never, {} as never)
}

function registerCheckpoint(store: FakeStore): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the checkpoint handler calls only the session/UI/flush methods FakeStore implements.
  registerRendererShutdownCheckpointHandler(store as never)
}

function sender(frame: unknown = MAIN_FRAME): IpcEvent {
  return { sender: { id: WEB_CONTENTS_ID, mainFrame: MAIN_FRAME }, senderFrame: frame }
}

describe('obsolete window document writes', () => {
  const reload = vi.fn()

  beforeEach(() => {
    syncHandlers.clear()
    invokeHandlers.clear()
    obsoleteWindowDocuments.resetForTests()
    obsoleteWindowDocuments.registerWindow(WEB_CONTENTS_ID, reload)
    obsoleteWindowDocuments.onDocumentCommitted(WEB_CONTENTS_ID)
    reload.mockReset()
  })

  afterEach(() => {
    obsoleteWindowDocuments.resetForTests()
  })

  it('admits a normal window exactly as before', async () => {
    const { store } = createStore({ local: session({}) })
    registerSession(store)
    const next = session({ [WT]: [row('/work/a.md')] })

    await invokeHandlers.get('session:set')!(sender(), next)
    await invokeHandlers.get('session:patch')!(sender(), { activeTabId: 'x' })

    expect(store.setWorkspaceSession).toHaveBeenCalledWith(next, undefined)
    expect(store.patchWorkspaceSession).toHaveBeenCalledWith({ activeTabId: 'x' }, undefined)
  })

  it('keeps only drafts from an obsolete document; rows, wrappers and focus never land', async () => {
    const { store, sessions } = createStore({
      local: session({ [WT]: [row('/work/a.md'), row('/work/host-opened.md')] })
    })
    registerSession(store)
    obsoleteWindowDocuments.markAllObsolete()

    // A stale full write: it never saw host-opened.md and still lists a host-closed file.
    expect(
      invokeHandlers.get('session:set')!(
        sender(),
        session({
          [WT]: [
            row('/work/a.md', { dirtyDraftContent: '', lastKnownDiskSignature: 's1' }),
            row('/work/closed.md')
          ]
        })
      )
    ).toBeUndefined()

    expect(sessions.get('local')!.openFilesByWorktree?.[WT]).toEqual([
      row('/work/a.md', { dirtyDraftContent: '', lastKnownDiskSignature: 's1' }),
      row('/work/host-opened.md')
    ])
  })

  it('merges later typing from an obsolete document and never clears a draft with a clean row', async () => {
    const { store, sessions } = createStore({
      local: session({
        [WT]: [row('/work/a.md', { dirtyDraftContent: 'one', lastKnownDiskSignature: 's1' })]
      })
    })
    registerSession(store)
    obsoleteWindowDocuments.markAllObsolete()

    await invokeHandlers.get('session:patch')!(sender(), {
      openFilesByWorktree: {
        [WT]: [row('/work/a.md', { dirtyDraftContent: 'one two', lastKnownDiskSignature: 's1' })]
      }
    })
    expect(sessions.get('local')!.openFilesByWorktree?.[WT]?.[0]?.dirtyDraftContent).toBe('one two')

    await invokeHandlers.get('session:patch')!(sender(), {
      openFilesByWorktree: { [WT]: [row('/work/a.md')] }
    })
    expect(sessions.get('local')!.openFilesByWorktree?.[WT]?.[0]?.dirtyDraftContent).toBe('one two')
    expect(store.patchWorkspaceSession).not.toHaveBeenCalled()
  })

  it('never manufactures a baseline for a legacy draft that had none', async () => {
    const { store, sessions } = createStore({
      local: session({ [WT]: [row('/work/a.md', { lastKnownDiskSignature: 'older' })] })
    })
    registerSession(store)
    obsoleteWindowDocuments.markAllObsolete()

    await invokeHandlers.get('session:set')!(
      sender(),
      session({ [WT]: [row('/work/a.md', { dirtyDraftContent: 'legacy' })] })
    )

    expect(sessions.get('local')!.openFilesByWorktree?.[WT]?.[0]).toEqual(
      row('/work/a.md', { dirtyDraftContent: 'legacy' })
    )
  })

  it('answers set-sync with its best-effort true and drops a superseded frame', () => {
    const { store } = createStore({ local: session({}) })
    registerSession(store)
    const event = sender({ frame: 'disposed' })

    syncHandlers.get('session:set-sync')!(event, session({ [WT]: [row('/work/x.md')] }))

    return vi.waitFor(() => {
      expect(event.returnValue).toBe(true)
      expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    })
  })

  it('checkpoint: merges drafts, joins the flush, and does not veto unload', async () => {
    const { store, sessions } = createStore({
      local: session({ [WT]: [row('/work/a.md')] }),
      'ssh:t1': session({ [WT]: [row('/work/b.md')] })
    })
    registerCheckpoint(store)
    obsoleteWindowDocuments.markAllObsolete()
    const { appApi } = await import('../../preload/api/app-bridge')

    expect(() =>
      appApi.stageBeforeUnloadSync({
        sessions: [
          { state: session({ [WT]: [row('/work/a.md', { dirtyDraftContent: 'A' })] }) },
          {
            state: session({ [WT]: [row('/work/b.md', { dirtyDraftContent: 'B' })] }),
            hostId: 'ssh:t1'
          }
        ],
        ui: {}
      })
    ).not.toThrow()

    expect(store.stageWorkspaceSessionBeforeUnload).not.toHaveBeenCalled()
    expect(sessions.get('local')!.openFilesByWorktree?.[WT]?.[0]?.dirtyDraftContent).toBe('A')
    expect(sessions.get('ssh:t1')!.openFilesByWorktree?.[WT]?.[0]?.dirtyDraftContent).toBe('B')
    await expect(invokeHandlers.get('app:await-before-unload-checkpoint')!({})).resolves.toEqual({
      ok: true
    })
    expect(store.flushPendingOrThrowAsync).toHaveBeenCalled()
  })

  it('checkpoint: a draft for a file the host closed fails the whole checkpoint, merging nothing', async () => {
    const { store, sessions } = createStore({
      local: session({ [WT]: [row('/work/a.md')] }),
      'ssh:t1': session({ [WT]: [] })
    })
    registerCheckpoint(store)
    obsoleteWindowDocuments.markAllObsolete()
    const { appApi } = await import('../../preload/api/app-bridge')

    expect(() =>
      appApi.stageBeforeUnloadSync({
        sessions: [
          { state: session({ [WT]: [row('/work/a.md', { dirtyDraftContent: 'kept' })] }) },
          {
            state: session({ [WT]: [row('/work/closed.md', { dirtyDraftContent: 'lost?' })] }),
            hostId: 'ssh:t1'
          }
        ],
        ui: {}
      })
    ).toThrow('Failed to stage renderer state before unload.')

    expect(sessions.get('local')!.openFilesByWorktree?.[WT]?.[0]?.dirtyDraftContent).toBeUndefined()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.stageWorkspaceSessionBeforeUnload).not.toHaveBeenCalled()
    await expect(invokeHandlers.get('app:await-before-unload-checkpoint')!({})).resolves.toEqual({
      ok: false
    })
  })

  it('checkpoint: a failed merge write takes the existing failure path', async () => {
    const { store } = createStore({ local: session({ [WT]: [row('/work/a.md')] }) })
    store.setWorkspaceSession.mockImplementation(() => {
      throw new Error('disk')
    })
    registerCheckpoint(store)
    obsoleteWindowDocuments.markAllObsolete()
    const event = sender()

    syncHandlers.get('app:stage-before-unload-sync')!(event, {
      sessions: [{ state: session({ [WT]: [row('/work/a.md', { dirtyDraftContent: 'x' })] }) }],
      ui: {}
    })

    expect(event.returnValue).toEqual({ ok: false })
  })

  it('checkpoint: a normal window close stages as today', () => {
    const { store } = createStore({ local: session({}) })
    registerCheckpoint(store)
    const event = sender()
    const state = session({ [WT]: [row('/work/a.md')] })

    syncHandlers.get('app:stage-before-unload-sync')!(event, { sessions: [{ state }], ui: {} })

    expect(event.returnValue).toEqual({ ok: true })
    expect(store.stageWorkspaceSessionBeforeUnload).toHaveBeenCalledWith(state, undefined)
  })

  it('a new committed document is no longer obsolete; a cancelled reload leaves it obsolete', () => {
    obsoleteWindowDocuments.markAllObsolete()
    expect(obsoleteWindowDocuments.requestReloadOnce(WEB_CONTENTS_ID)).toBe(true)
    // Cancelled navigation: no commit, so the surviving document stays fenced with no retry.
    expect(obsoleteWindowDocuments.requestReloadOnce(WEB_CONTENTS_ID)).toBe(false)
    expect(obsoleteWindowDocuments.isObsolete(WEB_CONTENTS_ID)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)

    obsoleteWindowDocuments.onDocumentCommitted(WEB_CONTENTS_ID)
    expect(obsoleteWindowDocuments.isObsolete(WEB_CONTENTS_ID)).toBe(false)
  })
})

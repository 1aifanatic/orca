import { describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { returnValue?: unknown }, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler)
      }
    ),
    on: vi.fn(
      (
        channel: string,
        handler: (event: { returnValue?: unknown }, ...args: unknown[]) => unknown
      ) => {
        handlers.set(channel, handler)
      }
    )
  }
}))

import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { registerRendererShutdownCheckpointHandler } from './renderer-shutdown-checkpoint'
import { registerSessionHandlers } from './session'

const WORKTREE = 'repo::/worktree'

function sessionWithTab(tabId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId: WORKTREE,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  }
}

describe('registerSessionHandlers', () => {
  it('drops renderer writes to a fenced host source partition and keeps every other one', async () => {
    const store = {
      getSshTarget: vi.fn((id: string) =>
        id === 'fenced' ? { orcadFence: { environmentId: 'env-1' } } : {}
      ),
      getWorkspaceSession: vi.fn(() => getDefaultWorkspaceSession()),
      setWorkspaceSession: vi.fn(),
      patchWorkspaceSession: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test touch only the store methods stubbed above and never the runtime.
    registerSessionHandlers(store as never, {} as never)

    for (const hostId of ['ssh:fenced', 'ssh:open', undefined]) {
      await handlers.get('session:set')?.({}, {}, hostId)
      await handlers.get('session:patch')?.({}, {}, hostId)
    }
    expect(store.setWorkspaceSession.mock.calls.map(([, hostId]) => hostId)).toEqual([
      'ssh:open',
      undefined
    ])
    expect(store.patchWorkspaceSession.mock.calls.map(([, hostId]) => hostId)).toEqual([
      'ssh:open',
      undefined
    ])

    const event: { returnValue?: unknown } = {}
    handlers.get('session:set-sync')?.(event, {}, 'ssh:fenced')
    await vi.waitFor(() => expect(event.returnValue).toBe(true))
    expect(store.setWorkspaceSession).toHaveBeenCalledTimes(2)
  })

  it('set, set-sync, patch and the quit stage all keep the tabs main holds', async () => {
    const written: WorkspaceSessionState['tabsByWorktree'][] = []
    const record = (session: Partial<WorkspaceSessionState>): void => {
      written.push(session.tabsByWorktree ?? {})
    }
    const store = {
      getSshTarget: vi.fn(() => ({})),
      getWorkspaceSession: vi.fn(() => sessionWithTab('main-tab')),
      setWorkspaceSession: vi.fn(record),
      patchWorkspaceSession: vi.fn(record),
      stageWorkspaceSessionBeforeUnload: vi.fn(record),
      updateUI: vi.fn(),
      flushPendingOrThrowAsync: vi.fn(() => Promise.resolve())
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test touch only the store methods stubbed above and never the runtime.
    registerSessionHandlers(store as never, {} as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    registerRendererShutdownCheckpointHandler(store as never)
    const stale = sessionWithTab('stale-tab')

    await handlers.get('session:set')?.({}, stale)
    await handlers.get('session:patch')?.({}, { tabsByWorktree: stale.tabsByWorktree })
    const event: { returnValue?: unknown } = {}
    handlers.get('session:set-sync')?.(event, stale)
    await vi.waitFor(() => expect(event.returnValue).toBe(true))
    handlers.get('app:stage-before-unload-sync')?.({}, { sessions: [{ state: stale }], ui: {} })

    expect(written).toEqual(Array(4).fill(sessionWithTab('main-tab').tabsByWorktree))
  })
})

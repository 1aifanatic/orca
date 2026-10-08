import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseTerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import {
  parseTerminalLayoutSetRequest,
  type TerminalLayoutSetResult
} from '../../shared/terminal-layout-set'
import {
  parseTerminalLeafBindRequest,
  type TerminalLeafBindResult
} from '../../shared/terminal-leaf-bind'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { sleepingAgentSessionsByPaneKeySchema } from '../../shared/workspace-session-sleeping-agents'
import {
  bindLeaf,
  clearLaunchAgent,
  commitSleepingRecords
} from '../persistence/terminal-topology/terminal-topology-commit'
import {
  patchRendererSession,
  setRendererSession
} from '../persistence/terminal-topology/terminal-renderer-presentation-save'

export function registerSessionHandlers(store: Store, runtime: OrcaRuntimeService): void {
  // Why: renderer saves would change a fenced host's frozen source partition.
  const isFenced = (hostId?: string | null): boolean =>
    isFrozenOrcadSourceSessionPartition(store, hostId)

  // Why: hostId is an optional second arg so an older renderer that invokes
  // these channels without it keeps reading/writing the 'local' partition
  // exactly as before. Channel names stay stable.
  ipcMain.handle('session:get', (_event, hostId?: string | null) => {
    return store.getWorkspaceSession(hostId)
  })

  // Why a census channel: boot used to infer which partitions exist from the repo catalog, which
  // cannot name an SSH target whose only workspace is a folder — the runtime wrote that partition
  // and no reader ever enumerated it (#12723).
  ipcMain.handle('session:list-host-ids', () => {
    return store.getWorkspaceSessionHostIds()
  })

  ipcMain.handle('session:set', (_event, args: WorkspaceSessionState, hostId?: string | null) => {
    if (!isFenced(hostId)) {
      setRendererSession(store, args, hostId)
    }
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    if (!isFenced(hostId)) {
      patchRendererSession(store, args, hostId)
    }
  })

  // Why: a renderer save cannot shrink membership main owns, so each close commits it explicitly.
  ipcMain.handle(
    'session:close-terminal-surface',
    async (
      _event,
      args: { worktreeId?: unknown; target?: unknown; reason?: unknown } | undefined
    ) => {
      const target = parseTerminalSurfaceCloseTarget(args?.target)
      if (typeof args?.worktreeId !== 'string' || !target) {
        throw new Error('invalid_terminal_surface')
      }
      // Why only these two: main alone closes a tab for its process exit.
      const reason = args.reason === 'cleanup' ? 'cleanup' : 'user'
      if (reason === 'user') {
        // A launch still starting or delivering in what the user closed stops, and says so.
        markAgentLaunchesClosedByUser(args.worktreeId, target)
      }
      await runtime.closeTerminalSurfaceFromRenderer({
        worktreeId: args.worktreeId,
        target,
        reason
      })
      return { publishSeq: runtime.settleTerminalTopology(args.worktreeId) }
    }
  )

  // A window's own sleeping-agent changes, written in each worktree's home; main's push carries them.
  ipcMain.handle(
    'session:commit-terminal-sleeping-records',
    (_event, changes: { sleep?: unknown; wake?: unknown } | undefined) => {
      commitSleepingRecords(
        store,
        {
          sleep: sleepingAgentSessionsByPaneKeySchema.safeParse(changes?.sleep).data ?? {},
          wake: Array.isArray(changes?.wake)
            ? changes.wake.filter((paneKey) => typeof paneKey === 'string')
            : []
        },
        (worktreeId) => runtime.getTerminalTopologyHomeHostId(worktreeId),
        isFenced
      )
    }
  )

  // The window saw a tab's launched agent go; main's row drops it so no save or push brings it back.
  ipcMain.handle(
    'session:terminal-clear-launch-agent',
    (_event, args: { worktreeId?: unknown; tabId?: unknown } | undefined) => {
      if (typeof args?.worktreeId !== 'string' || typeof args.tabId !== 'string') {
        return
      }
      const hostId = runtime.getTerminalTopologyHomeHostId(args.worktreeId)
      if (hostId && !isFenced(hostId)) {
        clearLaunchAgent(store, { worktreeId: args.worktreeId, tabId: args.tabId }, hostId)
      }
    }
  )

  // A gesture's geometry; the reply's publishSeq tells the window when main's push holds it.
  ipcMain.handle('session:terminal-set-layout', async (_event, args: unknown) => {
    const request = parseTerminalLayoutSetRequest(args)
    if (!request) {
      return { status: 'refused', reason: 'invalid_request' } satisfies TerminalLayoutSetResult
    }
    // One home per worktree; an unresolved one is unverifiable, so nothing is written.
    const hostId = runtime.getTerminalTopologyHomeHostId(request.worktreeId)
    const result: TerminalLayoutSetResult = hostId
      ? await store.setTerminalTabLayout(request, hostId)
      : { status: 'refused', reason: 'home_unresolved' }
    return { ...result, publishSeq: runtime.settleTerminalTopology(request.worktreeId) }
  })

  // An adopted live PTY: main records it on its pane, and the push carries it to the window.
  ipcMain.handle('session:terminal-bind-leaf', async (_event, args: unknown) => {
    const request = parseTerminalLeafBindRequest(args)
    if (!request) {
      return { status: 'refused', reason: 'invalid_request' } satisfies TerminalLeafBindResult
    }
    const hostId = runtime.getTerminalTopologyHomeHostId(request.worktreeId)
    const bound = hostId !== null && (await bindLeaf(store, request, hostId))
    const result: TerminalLeafBindResult = bound
      ? { status: 'bound' }
      : { status: 'refused', reason: hostId ? 'not_bound' : 'home_unresolved' }
    return { ...result, publishSeq: runtime.settleTerminalTopology(request.worktreeId) }
  })

  // Pull-after-listen: a window subscribes to pushes first, then reads what it missed.
  ipcMain.handle('session:get-terminal-topology-slices', () => runtime.getTerminalTopologySlices())

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    return store.flushPendingOrThrowAsync()
  })

  // Older renderers block on the reply; main remains free to await the writer.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    void (async () => {
      try {
        if (!isFenced(hostId)) {
          setRendererSession(store, args, hostId)
        }
        await store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      } catch (error) {
        console.error('[persistence] Failed to flush legacy session checkpoint:', error)
      } finally {
        // This legacy response has always been best effort, including on disk errors.
        event.returnValue = true
      }
    })()
  })

  ipcMain.on(
    'session:read-terminal-scrollback-sync',
    (event, args: { ref?: unknown } | undefined) => {
      event.returnValue =
        typeof args?.ref === 'string' ? store.readTerminalScrollbackSnapshot(args.ref) : null
    }
  )
}

import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseTerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import { isFrozenOrcadSourceSessionPartition } from '../ssh/orcad-retained-source'
import { markAgentLaunchesClosedByUser } from '../agent-launch/agent-launch-pane-attachment'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import type { TerminalSleepingRecordChanges } from '../../shared/terminal-topology-slice'
import { sleepingAgentSessionsByPaneKeySchema } from '../../shared/workspace-session-sleeping-agents'
import { sleepLeaf, wakeLeaf } from '../persistence/terminal-topology/terminal-topology-commit'
import { isTerminalOwnerPartition } from '../persistence/terminal-topology/terminal-topology-membership'

/** Commits a window's own sleeping-agent record changes; main's next topology push carries them. */
export function commitTerminalSleepingRecords(
  store: Store,
  changes: { sleep?: unknown; wake?: unknown } | undefined
): void {
  const parsed: TerminalSleepingRecordChanges = {
    sleep: sleepingAgentSessionsByPaneKeySchema.safeParse(changes?.sleep).data ?? {},
    wake: Array.isArray(changes?.wake)
      ? changes.wake.filter((paneKey) => typeof paneKey === 'string')
      : []
  }
  if (Object.keys(parsed.sleep).length === 0 && parsed.wake.length === 0) {
    return
  }
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    if (!isTerminalOwnerPartition(hostId) || isFrozenOrcadSourceSessionPartition(store, hostId)) {
      continue
    }
    const session = store.getWorkspaceSession(hostId)
    const next = sleepLeaf(wakeLeaf(session, parsed.wake), parsed.sleep)
    if (next !== session) {
      store.patchWorkspaceSession(
        { sleepingAgentSessionsByPaneKey: next.sleepingAgentSessionsByPaneKey },
        hostId
      )
    }
  }
}

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
      store.setWorkspaceSession(args, hostId)
    }
  })

  ipcMain.handle('session:patch', (_event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    if (!isFenced(hostId)) {
      store.patchWorkspaceSession(args, hostId)
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

  ipcMain.handle('session:terminal-sleep-leaves', (_event, sleep: unknown) => {
    commitTerminalSleepingRecords(store, { sleep })
  })

  ipcMain.handle('session:terminal-wake-leaves', (_event, wake: unknown) => {
    commitTerminalSleepingRecords(store, { wake })
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
          store.setWorkspaceSession(args, hostId)
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

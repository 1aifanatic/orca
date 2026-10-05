import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { parseTerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import {
  classifyRendererSessionWrite,
  obsoleteWindowDocuments,
  type RendererSessionWriteEvent
} from '../window/obsolete-window-documents'
import { mergeObsoleteDocumentDrafts } from './obsolete-document-session-writes'

/**
 * True when the write may land as today. A document that missed a host editor commit (or a
 * superseded main frame) gets the normal success reply, but only its unsaved drafts are kept.
 */
function admitRendererSessionWrite(
  store: Store,
  event: RendererSessionWriteEvent,
  payload: WorkspaceSessionPatch,
  hostId: string | null | undefined
): boolean {
  const admission = classifyRendererSessionWrite(event)
  if (admission === 'admit') {
    return true
  }
  const webContentsId = typeof event.sender?.id === 'number' ? event.sender.id : -1
  if (obsoleteWindowDocuments.shouldLogDiscard(webContentsId)) {
    console.warn(`[session] Discarding session writes from a ${admission} window document`)
  }
  if (admission === 'obsolete') {
    const merge = mergeObsoleteDocumentDrafts(store.getWorkspaceSession(hostId), payload)
    if (merge.absentDrafts > 0) {
      // Why only logged: the live document still holds the text; its unload checkpoint refuses.
      console.warn(`[session] Kept ${merge.absentDrafts} draft(s) out of a stale window document`)
    }
    if (merge.changed) {
      store.setWorkspaceSession(merge.merged, hostId)
    }
  }
  return false
}

export function registerSessionHandlers(store: Store, runtime: OrcaRuntimeService): void {
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

  ipcMain.handle('session:set', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    if (admitRendererSessionWrite(store, event, args, hostId)) {
      store.setWorkspaceSession(args, hostId)
    }
  })

  ipcMain.handle('session:patch', (event, args: WorkspaceSessionPatch, hostId?: string | null) => {
    if (admitRendererSessionWrite(store, event, args, hostId)) {
      store.patchWorkspaceSession(args, hostId)
    }
  })

  // Why: a renderer save cannot shrink membership main owns, so each close commits it explicitly.
  ipcMain.handle(
    'session:close-terminal-surface',
    (_event, args: { worktreeId?: unknown; target?: unknown; reason?: unknown } | undefined) => {
      const target = parseTerminalSurfaceCloseTarget(args?.target)
      if (typeof args?.worktreeId !== 'string' || !target) {
        throw new Error('invalid_terminal_surface')
      }
      // Why only these two: main alone closes a tab for its process exit.
      return runtime.closeTerminalSurfaceFromRenderer({
        worktreeId: args.worktreeId,
        target,
        reason: args.reason === 'cleanup' ? 'cleanup' : 'user'
      })
    }
  )

  ipcMain.handle('session:flush', () => {
    // Why: durable lifecycle RPCs must propagate disk failures instead of
    // returning success through Store.flush(), which intentionally only logs.
    return store.flushPendingOrThrowAsync()
  })

  // Older renderers block on the reply; main remains free to await the writer.
  ipcMain.on('session:set-sync', (event, args: WorkspaceSessionState, hostId?: string | null) => {
    void (async () => {
      try {
        if (admitRendererSessionWrite(store, event, args, hostId)) {
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

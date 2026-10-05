import { ipcMain } from 'electron'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'
import { classifyRendererSessionWrite } from '../window/obsolete-window-documents'
import { mergeObsoleteDocumentDrafts } from './obsolete-document-session-writes'

type StageBeforeUnloadSyncArgs = {
  sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
  ui: Partial<PersistedUIState>
}

export type ShutdownCheckpointResult = { ok: boolean }

/** Matches the will-quit teardown budget so a stalled disk can't strand a restart. */
export const SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS = 20_000

function flushStagedStateWithDeadline(store: Store): Promise<ShutdownCheckpointResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<ShutdownCheckpointResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      console.error('[app] Timed out persisting staged renderer state')
      resolve({ ok: false })
    }, SHUTDOWN_CHECKPOINT_FLUSH_DEADLINE_MS)
  })
  // Why not drain to stable: Store retries a superseded staged write without
  // chasing unrelated live mutations, which the deadline would otherwise cut off.
  const flush = store
    .flushPendingOrThrowAsync({ signal: controller.signal, drainToStableGeneration: false })
    .then((): ShutdownCheckpointResult => ({ ok: true }))
    .catch((error): ShutdownCheckpointResult => {
      console.error('[app] Failed to persist staged renderer state:', error)
      return { ok: false }
    })
  return Promise.race([flush, deadline]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

/**
 * A stale window document's checkpoint keeps only its unsaved drafts, merged onto the current
 * session's matching rows. If any draft has no row anymore, nothing is merged and the checkpoint
 * fails, so the window's unload guard keeps the document (and the text) alive.
 */
function stageObsoleteDocumentDrafts(store: Store, args: StageBeforeUnloadSyncArgs): boolean {
  try {
    // Why preflight every partition first: one unmergeable draft must leave nothing merged anywhere.
    const working = new Map<
      ExecutionHostId | undefined,
      { session: WorkspaceSessionState; changed: boolean }
    >()
    for (const { state, hostId } of args.sessions) {
      const previous = working.get(hostId)
      const merge = mergeObsoleteDocumentDrafts(
        previous?.session ?? store.getWorkspaceSession(hostId),
        state
      )
      if (merge.absentDrafts > 0) {
        console.warn('[app] A stale window document holds drafts for files no longer open')
        return false
      }
      working.set(hostId, {
        session: merge.merged,
        changed: (previous?.changed ?? false) || merge.changed
      })
    }
    for (const [hostId, { session, changed }] of working) {
      if (changed) {
        store.setWorkspaceSession(session, hostId)
      }
    }
    store.updateUI(args.ui)
    return true
  } catch (error) {
    console.error('[app] Failed to keep drafts from a stale window document:', error)
    return false
  }
}

export function registerRendererShutdownCheckpointHandler(store: Store): void {
  // Why: beforeunload cannot await, so the sync reply only reports staging.
  // Durability is joined out-of-band by paths that are about to navigate.
  let pendingCheckpoint: Promise<ShutdownCheckpointResult> = Promise.resolve({ ok: true })

  ipcMain.on('app:stage-before-unload-sync', (event, args: StageBeforeUnloadSyncArgs) => {
    const admission = classifyRendererSessionWrite(event)
    if (admission !== 'admit') {
      const staged = admission === 'obsolete' ? stageObsoleteDocumentDrafts(store, args) : true
      pendingCheckpoint =
        admission === 'obsolete' && staged
          ? flushStagedStateWithDeadline(store)
          : Promise.resolve({ ok: staged })
      event.returnValue = { ok: staged }
      return
    }
    let ok = true
    try {
      for (const { state, hostId } of args.sessions) {
        store.stageWorkspaceSessionBeforeUnload(state, hostId)
      }
      store.updateUI(args.ui)
    } catch (error) {
      console.error('[app] Failed to stage renderer state before unload:', error)
      ok = false
    }
    pendingCheckpoint = ok ? flushStagedStateWithDeadline(store) : Promise.resolve({ ok: false })
    event.returnValue = { ok }
  })

  ipcMain.handle(
    'app:await-before-unload-checkpoint',
    (): Promise<ShutdownCheckpointResult> => pendingCheckpoint
  )
}

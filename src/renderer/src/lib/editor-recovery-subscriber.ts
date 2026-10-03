import type { AppState } from '@/store/types'
import type { EditorRecoveryApi, EditorRecoveryChange } from '../../../shared/editor-recovery'
import { shouldPersistWorkspaceSession } from './workspace-session'
import {
  registerEditorRecoveryFlush,
  registerEditorRecoveryResolver
} from './editor-recovery-checkpoints'
import {
  EditorRecoveryBufferTracker,
  type EditorRecoveryBuffer
} from './editor-recovery-buffer-tracker'
import {
  getExternalRecoveryBuffers,
  subscribeExternalRecoveryBuffers
} from './editor-recovery-external-buffers'
type RecoverySubscriberDeps = {
  store: {
    getState: () => AppState
    subscribe: (listener: (state: AppState) => void) => () => void
  }
  api: EditorRecoveryApi
  flushPendingChanges: (fileId: string) => void
  onError: (error: unknown) => void
  onPersisted?: () => void
  delayMs?: number
  maxWaitMs?: number
}

/** Checkpoints only changed buffers; neither layout churn nor a pause in typing is required. */
export function createEditorRecoverySubscriber({
  store,
  api,
  flushPendingChanges,
  onError,
  onPersisted,
  delayMs = 250,
  maxWaitMs = 500
}: RecoverySubscriberDeps): {
  dispose: () => void
  flush: () => Promise<void>
  resolve: (fileId: string, savedContent?: string) => Promise<void>
} {
  const tracker = new EditorRecoveryBufferTracker()
  const { buffers, pending } = tracker
  let previous = store.getState()
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstPendingAt: number | null = null
  let draining: Promise<void> | null = null
  let disposed = false
  const capture = (state: AppState): void => {
    tracker.capture(state, getExternalRecoveryBuffers())
  }

  const drain = (): Promise<void> => {
    if (draining) {
      return draining
    }
    const operation = (async () => {
      while (pending.size > 0) {
        const batch: {
          buffer: EditorRecoveryBuffer
          version: number
          change: EditorRecoveryChange
        }[] = []
        for (const id of pending) {
          const buffer = buffers.get(id)
          if (!buffer) {
            pending.delete(id)
            continue
          }
          const change: EditorRecoveryChange =
            buffer.state === 'resolved'
              ? { kind: 'resolve', id, expectedRevision: buffer.revision }
              : buffer.state === 'retained' && buffer.durableContent === buffer.content
                ? { kind: 'retain', id, expectedRevision: buffer.revision }
                : {
                    kind: 'put',
                    id,
                    expectedRevision: buffer.revision,
                    metadata: buffer.metadata,
                    content: buffer.content,
                    state: buffer.state
                  }
          batch.push({ buffer, version: buffer.version, change })
          pending.delete(id)
          if (batch.length === 64) {
            break
          }
        }
        if (batch.length === 0) {
          continue
        }
        try {
          const acknowledgements = await api.apply(batch.map(({ change }) => change))
          for (const { buffer, version, change } of batch) {
            const ack = acknowledgements.find((entry) => entry.id === change.id)
            if (!ack || (ack.revision !== null && ack.revision !== change.expectedRevision + 1)) {
              throw new Error('Invalid recovery write acknowledgement')
            }
            tracker.acknowledge(buffer, version, change, ack.revision, !disposed)
          }
        } catch (error) {
          for (const { buffer } of batch) {
            if (buffers.has(buffer.id)) {
              pending.add(buffer.id)
            }
          }
          throw error
        }
      }
      onPersisted?.()
    })()
    draining = operation.finally(() => {
      draining = null
    })
    return draining
  }

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    firstPendingAt = null
    const state = store.getState()
    if (shouldPersistWorkspaceSession(state)) {
      for (const file of state.openFiles) {
        if (file.isDirty) {
          flushPendingChanges(file.id)
        }
      }
      capture(store.getState())
    }
    await drain()
  }
  const resolve = async (fileId: string, savedContent?: string): Promise<void> => {
    capture(store.getState())
    const buffer = tracker.resolve(fileId, savedContent)
    try {
      await drain()
    } catch (error) {
      if (buffer) {
        tracker.rejectResolution(buffer)
      }
      throw error
    }
  }

  const schedule = (): void => {
    if (disposed) {
      return
    }
    firstPendingAt ??= Date.now()
    if (timer !== null) {
      clearTimeout(timer)
    }
    timer = setTimeout(
      () => {
        void flush().catch((error) => {
          onError(error)
          if (!disposed) {
            timer = setTimeout(() => {
              timer = null
              schedule()
            }, 5_000)
          }
        })
      },
      Math.max(0, Math.min(delayMs, maxWaitMs - (Date.now() - firstPendingAt)))
    )
  }

  const evaluate = (state: AppState): void => {
    const prior = previous
    previous = state
    if (!shouldPersistWorkspaceSession(state)) {
      return
    }
    if (state.openFiles !== prior.openFiles) {
      // Capture removals before close or topology updates drop their draft map entries.
      capture(prior)
      capture(state)
    }
    if (
      state.editorDrafts !== prior.editorDrafts ||
      state.openFiles !== prior.openFiles ||
      !shouldPersistWorkspaceSession(prior)
    ) {
      schedule()
    }
  }
  capture(previous)
  if (pending.size > 0) {
    schedule()
  }
  const unsubscribe = store.subscribe(evaluate)
  const unsubscribeExternal = subscribeExternalRecoveryBuffers((removed) => {
    if (removed) {
      tracker.capture(store.getState(), [...getExternalRecoveryBuffers(), removed])
      capture(store.getState())
    }
    schedule()
  })
  const unregisterFlush = registerEditorRecoveryFlush(flush)
  const unregisterResolver = registerEditorRecoveryResolver(resolve)
  return {
    flush,
    resolve,
    dispose: () => {
      disposed = true
      unsubscribe()
      unsubscribeExternal()
      unregisterFlush()
      unregisterResolver()
      if (timer !== null) {
        clearTimeout(timer)
      }
      tracker.dispose()
    }
  }
}

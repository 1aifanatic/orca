import type { WorkerDispatchRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import {
  releaseContextOnlyDispatch,
  type ContextOnlyDispatchReleaseResult
} from '../../context-only-dispatch-release'
import type { OrchestrationDb } from '../orchestration-db'
import { reconcileTaskAfterDispatchInterruption } from '../dispatch-context/task-dispatch-reconciliation'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import { WORKER_SETTLED_STATES } from '../../worker-terminal-ownership'
import { isStopStrandedByAnotherRuntime } from './worker-dispatch-stop'

export function abandonWorkerDispatch(
  this: OrchestrationDb,
  dispatchId: string,
  runtimeEpoch: string,
  abandonedBy?: string
):
  | {
      disposition: 'abandoned' | 'already_abandoned' | 'already_settled'
      worker: WorkerDispatchRow
    }
  | ({ disposition: 'context_only' } & ContextOnlyDispatchReleaseResult) {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const worker = this.getWorkerDispatch(dispatchId)
    const dispatch = this.getDispatchContextById(dispatchId)
    if (!dispatch) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
    }
    if (!worker) {
      const released = releaseContextOnlyDispatch(this.db, dispatch, 'abandoned')
      if (!released.alreadySettled) {
        this.closeQuestionsForDispatch(dispatchId)
      }
      this.db.exec('COMMIT')
      return { disposition: 'context_only', ...released }
    }
    // Only this runtime's own in-flight stop is refused: it always ends in stopped or stop_unknown.
    if (worker.state === 'stopping' && !isStopStrandedByAnotherRuntime(worker, runtimeEpoch)) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is stopping; wait for worker-stop to settle before abandoning.`
      )
    }
    const settles = !WORKER_SETTLED_STATES.includes(worker.state)
    if (settles) {
      const now = new Date().toISOString()
      transitionLifecycleWithDb(this.db, {
        entity: 'worker',
        id: dispatchId,
        from: worker.state,
        to: 'abandoned',
        projection: {
          stage: 'abandoned',
          last_error: `Abandoned by ${abandonedBy ?? 'an unidentified caller'}.`,
          updated_at: now
        }
      })
      if (['pending', 'dispatched'].includes(dispatch.status)) {
        transitionLifecycleWithDb(this.db, {
          entity: 'dispatch',
          id: dispatchId,
          from: dispatch.status,
          to: 'failed',
          projection: {
            last_failure: 'abandoned',
            capability_revoked_at: dispatch.capability_revoked_at ?? now,
            completed_at: dispatch.completed_at ?? now
          }
        })
      }
      reconcileTaskAfterDispatchInterruption(this, dispatch.task_id, dispatchId)
      this.closeQuestionsForDispatch(dispatchId)
    }
    // Abandon hands the terminal back instead of closing it, so a stuck release stops owing action.
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
         SET release_state = 'retained', retained_reason = 'user_requested',
             updated_at = datetime('now')
         WHERE owner_dispatch_id = ? AND ownership_state = 'owned'
           AND release_state IN ('not_requested', 'requested', 'unknown')`
      )
      .run(dispatchId)
    this.db.exec('COMMIT')
    return {
      disposition: settles
        ? 'abandoned'
        : worker.state === 'abandoned'
          ? 'already_abandoned'
          : 'already_settled',
      worker: this.getWorkerDispatch(dispatchId) as WorkerDispatchRow
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type WorkerDispatchAbandonMethods = {
  abandonWorkerDispatch: typeof abandonWorkerDispatch
}

export function attachWorkerDispatchAbandon(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    abandonWorkerDispatch
  })
}

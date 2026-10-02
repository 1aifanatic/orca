import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { createRootDispatch } from './root-dispatch-test-fixture'

let db: OrchestrationDb | undefined

afterEach(() => {
  vi.restoreAllMocks()
  db?.close()
  db = undefined
})

describe('task listing with dispatch statement compilation', () => {
  it('compiles each filter shape once while preserving complete rows and fresh bindings', () => {
    db = new OrchestrationDb(':memory:')
    const firstRun = db.createRun({
      objective: 'first',
      coordinatorHandle: 'term_first',
      coordinatorPaneKey: 'tab_first:leaf_first'
    })
    const secondRun = db.createRun({
      objective: 'second',
      coordinatorHandle: 'term_second',
      coordinatorPaneKey: 'tab_second:leaf_second'
    })
    const firstTask = db.createTask({
      spec: 'first task',
      runId: firstRun.id,
      taskTitle: 'Task title',
      displayName: 'Task display',
      createdByTerminalHandle: 'term_first',
      createdByPaneKey: 'tab_first:leaf_first',
      createdByProcessIncarnation: 'inc_first',
      createdByRunGeneration: firstRun.consumer_generation
    })
    const secondTask = db.createTask({ spec: 'second task', runId: secondRun.id })
    const dispatch = createRootDispatch(db, firstTask.id, 'term_worker', 'tab_worker:leaf_worker')
    const expected = db.db
      .prepare(
        `SELECT t.*, d.assignee_handle, d.id AS dispatch_id
         FROM tasks t LEFT JOIN dispatch_contexts d ON d.rowid = (
           SELECT candidate.rowid FROM dispatch_contexts candidate
           WHERE candidate.task_id = t.id AND candidate.status IN ('pending', 'dispatched')
           ORDER BY candidate.rowid DESC LIMIT 1
         ) ORDER BY t.created_at`
      )
      .all()
    const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')

    for (let call = 0; call < 5; call += 1) {
      expect(db.listTasksWithDispatch()).toEqual(expected)
      expect(db.listTasksWithDispatch({ runId: firstRun.id })).toEqual(
        expected.filter((row) => row.run_id === firstRun.id)
      )
      expect(db.listTasksWithDispatch({ runId: secondRun.id })).toEqual(
        expected.filter((row) => row.run_id === secondRun.id)
      )
      expect(db.listTasksWithDispatch({ ready: true })).toEqual(
        expected.filter((row) => row.status === 'ready')
      )
      expect(db.listTasksWithDispatch({ status: 'pending' })).toEqual(
        expected.filter((row) => row.status === 'pending')
      )
      expect(db.listTasksWithDispatch({ status: 'ready' })).toEqual(
        expected.filter((row) => row.status === 'ready')
      )
    }

    expect(compile).toHaveBeenCalledTimes(4)
    expect(new Set(compile.mock.calls.map(([sql]) => sql)).size).toBe(4)
    expect(expected.find((row) => row.id === firstTask.id)?.dispatch_id).toBe(dispatch.id)
    expect(expected.find((row) => row.id === secondTask.id)?.dispatch_id).toBeNull()

    db.db.prepare('UPDATE tasks SET spec = ? WHERE id = ?').run('updated task', secondTask.id)
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_updated', dispatch.id)
    const compilationCount = compile.mock.calls.length
    expect(db.listTasksWithDispatch({ runId: secondRun.id })[0]?.spec).toBe('updated task')
    expect(db.listTasksWithDispatch({ runId: firstRun.id })[0]?.assignee_handle).toBe(
      'term_updated'
    )
    expect(compile).toHaveBeenCalledTimes(compilationCount)
  })
})

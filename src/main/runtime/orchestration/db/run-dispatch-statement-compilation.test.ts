import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { getActiveDispatchForTask } from './dispatch-context/task-dispatch-reconciliation'
import { createRootDispatch } from './root-dispatch-test-fixture'
import { exposeUtcTimestamp } from './utc-timestamp'

const databases: OrchestrationDb[] = []
const directories: string[] = []
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-run-dispatch-compilation-'))
  directories.push(directory)
  const path = join(directory, 'orchestration.db')
  const writer = new OrchestrationDb(path)
  databases.push(writer)
  const run = writer.createRun({
    objective: 'first objective',
    coordinatorHandle: 'term_first',
    coordinatorPaneKey: 'tab_first:leaf_first'
  })
  const nextRun = writer.createRun({
    objective: 'next objective',
    coordinatorHandle: 'term_next',
    coordinatorPaneKey: 'tab_next:leaf_next'
  })
  const task = writer.createTask({ spec: 'first work', runId: run.id })
  const nextTask = writer.createTask({ spec: 'next work', runId: nextRun.id })
  const dispatch = createRootDispatch(writer, task.id, 'term_worker', WORKER_PANE)
  const nextDispatch = createRootDispatch(
    writer,
    nextTask.id,
    'term_next_worker',
    'tab_next:leaf_next'
  )
  writer.db
    .prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?')
    .run('completed', nextDispatch.id)
  writer.db
    .prepare('UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-10-01 12:00:00', '2026-10-01 13:00:00', run.id)
  writer.db
    .prepare('UPDATE runs SET created_at = ?, updated_at = ? WHERE id = ?')
    .run('2026-10-01 11:00:00', '2026-10-01 11:30:00', nextRun.id)
  const reader = new OrchestrationDb(path)
  databases.push(reader)
  return { writer, reader, run, nextRun, task, nextTask, dispatch, nextDispatch }
}

describe('run and dispatch metadata statement compilation', () => {
  it('reuses all dispatch lookup shapes with identical rows, identity precedence, and fresh state', () => {
    const { writer, reader, task, nextTask, dispatch, nextDispatch } = fixture()
    const expected = writer.db
      .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
      .get(dispatch.id)
    const completed = writer.db
      .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
      .get(nextDispatch.id)
    const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')

    for (let call = 0; call < 5; call += 1) {
      expect(reader.getDispatchContext(task.id)).toEqual(expected)
      expect(reader.getDispatchContext(nextTask.id)).toEqual(completed)
      expect(reader.getDispatchContextById(dispatch.id)).toEqual(expected)
      expect(reader.getDispatchContextById(nextDispatch.id)).toEqual(completed)
      expect(getActiveDispatchForTask(reader, task.id)).toEqual(expected)
      expect(getActiveDispatchForTask(reader, nextTask.id)).toBeUndefined()
      expect(reader.getActiveDispatchMailboxOwners('term_worker', 'other:pane')).toEqual([expected])
      expect(reader.getActiveDispatchMailboxOwners('missing', WORKER_PANE)).toEqual([expected])
      expect(
        reader.getActiveDispatchMailboxOwners(
          'missing',
          WORKER_PANE.replace('tab_worker:', 'reminted:')
        )
      ).toEqual([expected])
      expect(reader.getActiveDispatchMailboxOwners('missing', 'invalid:legacy')).toEqual([])
    }

    expect(compile).toHaveBeenCalledTimes(6)
    expect(new Set(compile.mock.calls.map(([sql]) => sql)).size).toBe(6)
    writer.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ?, last_failure = ? WHERE id = ?')
      .run('term_updated', 'fresh reason', dispatch.id)
    const compilationCount = compile.mock.calls.length
    expect(reader.getDispatchContextById(dispatch.id)).toEqual({
      ...expected,
      assignee_handle: 'term_updated',
      last_failure: 'fresh reason'
    })
    expect(reader.getActiveDispatchMailboxOwners('term_worker')).toEqual([])
    expect(reader.getActiveDispatchMailboxOwners('term_updated')[0]?.id).toBe(dispatch.id)
    expect(compile).toHaveBeenCalledTimes(compilationCount)

    writer.db
      .prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?')
      .run('completed', dispatch.id)
    const afterCompletionCount = compile.mock.calls.length
    expect(getActiveDispatchForTask(reader, task.id)).toBeUndefined()
    expect(reader.getActiveDispatchMailboxOwners('term_updated')).toEqual([])
    expect(reader.getDispatchContext(task.id)?.status).toBe('completed')
    expect(compile).toHaveBeenCalledTimes(afterCompletionCount)
  })

  it('reuses run-list SQL for full and cursor pages while reading complete, current rows', () => {
    const { writer, reader, run } = fixture()
    const expected = writer.db
      .prepare('SELECT * FROM runs ORDER BY created_at DESC, id DESC')
      .all()
      .map((row) => ({
        ...row,
        created_at:
          typeof row.created_at === 'string' ? exposeUtcTimestamp(row.created_at) : row.created_at,
        updated_at:
          typeof row.updated_at === 'string' ? exposeUtcTimestamp(row.updated_at) : row.updated_at
      }))
    const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')

    for (let call = 0; call < 5; call += 1) {
      expect(reader.listRuns()).toEqual({ runs: expected, nextCursor: null })
      const first = reader.listRuns({ limit: 1 })
      expect(first.runs).toEqual(expected.slice(0, 1))
      expect(first.nextCursor).toEqual(expect.any(String))
      if (!first.nextCursor) {
        throw new Error('Missing run-list cursor')
      }
      const second = reader.listRuns({ limit: 1, cursor: first.nextCursor })
      expect(second.runs).toEqual(expected.slice(1, 2))
      const larger = reader.listRuns({ limit: 2 })
      expect(larger.runs).toEqual(expected.slice(0, 2))
    }

    expect(compile).toHaveBeenCalledTimes(3)
    writer.db.prepare('UPDATE runs SET objective = ? WHERE id = ?').run('updated objective', run.id)
    const compilationCount = compile.mock.calls.length
    expect(reader.listRuns().runs.find((row) => row.id === run.id)?.objective).toBe(
      'updated objective'
    )
    expect(compile).toHaveBeenCalledTimes(compilationCount)
  })
})

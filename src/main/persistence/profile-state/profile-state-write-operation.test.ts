import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openProfileStateDatabase } from './profile-state-database'
import { writeProfileStateDomains } from './profile-state-domain-writes'
import { readProfileStateRevisionOperation } from './profile-state-revision'
import { assertProfileStateRevisionOnDisk } from './profile-state-revision-readmission'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function database() {
  const root = mkdtempSync(join(tmpdir(), 'orca-write-operation-'))
  roots.push(root)
  const path = join(root, 'profile-state.db')
  const opened = openProfileStateDatabase(path, 'operation-test')
  const write = (payload: string, expectedRevision: number, operationId?: string) =>
    writeProfileStateDomains(opened.db, {
      expectedRevision,
      replacements: [{ domain: 'ui', payload }],
      operationId
    }).revision
  return { path, db: opened.db, write, close: () => opened.db.close() }
}

it('records the operation id only in a transaction that commits a new revision', () => {
  const { db, write, close } = database()
  expect(write('{"a":1}', 0, 'token:1')).toBe(1)
  expect(readProfileStateRevisionOperation(db)).toEqual({ revision: 1, operationId: 'token:1' })
  // An unchanged payload commits nothing, so it must not claim the revision.
  expect(write('{"a":1}', 1, 'token:2')).toBe(1)
  expect(readProfileStateRevisionOperation(db).operationId).toBe('token:1')
  close()
})

it('adopts revision + 1 only when the interrupted operation recorded it', () => {
  const { path, write, close } = database()
  write('{"a":1}', 0)
  write('{"a":2}', 1, 'ours:7')
  close()
  expect(assertProfileStateRevisionOnDisk(path, 'operation-test', 1, 'ours:7')).toBe(2)
  expect(() => assertProfileStateRevisionOnDisk(path, 'operation-test', 1, 'ours:8')).toThrow(
    expect.objectContaining({ code: 'profile-state-revision-conflict' })
  )
  expect(() => assertProfileStateRevisionOnDisk(path, 'operation-test', 1)).toThrow(
    expect.objectContaining({ code: 'profile-state-revision-conflict' })
  )
})

it('refuses a foreign revision even when it is exactly one ahead', () => {
  const { path, write, close } = database()
  write('{"a":1}', 0, 'ours:1')
  // Another build or process commits without recording an operation id.
  write('{"a":2}', 1)
  close()
  expect(() => assertProfileStateRevisionOnDisk(path, 'operation-test', 1, 'ours:2')).toThrow(
    expect.objectContaining({ code: 'profile-state-revision-conflict' })
  )
  expect(assertProfileStateRevisionOnDisk(path, 'operation-test', 2, 'ours:2')).toBe(2)
})

it('rolls back the payload and revision when recording the operation fails', () => {
  const { db, write, close } = database()
  write('{"a":1}', 0, 'ours:1')
  db.exec(`CREATE TRIGGER reject_operation BEFORE INSERT ON profile_state_meta
    WHEN NEW.key = 'last_write_operation'
    BEGIN SELECT RAISE(ABORT, 'operation rejected'); END`)
  expect(() => write('{"a":2}', 1, 'ours:2')).toThrow('operation rejected')
  expect(readProfileStateRevisionOperation(db)).toEqual({ revision: 1, operationId: 'ours:1' })
  expect(
    db.prepare("SELECT payload FROM profile_state_documents WHERE domain = 'ui'").get()
  ).toEqual({ payload: '{"a":1}' })
  close()
})

it('refuses a matching operation at an unexpected revision', () => {
  const { path, write, close } = database()
  write('{"a":1}', 0, 'ours:1')
  write('{"a":2}', 1, 'ours:2')
  close()
  expect(() => assertProfileStateRevisionOnDisk(path, 'operation-test', 0, 'ours:2')).toThrow(
    expect.objectContaining({ code: 'profile-state-revision-conflict' })
  )
})

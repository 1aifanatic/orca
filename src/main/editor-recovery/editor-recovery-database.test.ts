import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { EditorRecoveryDatabase } from './editor-recovery-database'
import type { EditorRecoveryChange, EditorRecoveryMetadata } from '../../shared/editor-recovery'

const roots: string[] = []
const databases = new Set<EditorRecoveryDatabase>()
afterEach(() => {
  vi.restoreAllMocks()
  for (const database of databases) {
    database.close()
  }
  databases.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-editor-recovery-'))
  roots.push(root)
  const path = join(root, 'recovery.sqlite')
  const open = () => {
    const database = new EditorRecoveryDatabase(path)
    databases.add(database)
    return database
  }
  return { root, path, open }
}
function metadata(overrides: Partial<EditorRecoveryMetadata> = {}): EditorRecoveryMetadata {
  return {
    hostId: 'local',
    worktreeId: 'folder:one',
    filePath: '/same/note.txt',
    relativePath: 'note.txt',
    language: 'plaintext',
    bufferKind: 'edit',
    lastKnownDiskSignature: 'original-disk',
    ...overrides
  }
}
function put(
  id: string,
  content: string,
  expectedRevision = 0,
  owner = metadata()
): EditorRecoveryChange {
  return { kind: 'put', id, content, expectedRevision, metadata: owner, state: 'active' }
}

describe('durable editor recovery journal', () => {
  it('round-trips empty, Unicode and large drafts with separate host and surface identities', () => {
    const f = fixture()
    const database = f.open()
    const text = 'line\0😀\ud800\udc00\ud800\r\n'.repeat(100_000)
    const owners = [
      metadata(),
      metadata({ hostId: 'ssh:one' }),
      metadata({ hostId: 'runtime:one', runtimeEnvironmentId: 'one' }),
      metadata({ bufferKind: 'diff' })
    ]
    expect(
      database.apply(
        owners.map((owner, index) => put(`buffer-${index}`, index === 0 ? '' : text, 0, owner))
      )
    ).toEqual(owners.map((_, index) => ({ id: `buffer-${index}`, revision: 1 })))
    database.close()
    databases.delete(database)
    const reopened = f.open()
    expect(reopened.list()).toHaveLength(4)
    expect(reopened.list()[0]).not.toHaveProperty('content')
    for (const [index, owner] of owners.entries()) {
      expect(reopened.latestActive(owner)).toMatchObject({
        id: `buffer-${index}`,
        content: index === 0 ? '' : text,
        lastKnownDiskSignature: 'original-disk',
        revision: 1
      })
    }
  })

  it('retains a closed buffer and fences stale saves, discarded imports and delayed writes', () => {
    const database = fixture().open()
    database.importLegacy([{ metadata: metadata(), content: 'unsaved legacy text' }])
    const imported = database.list()[0]
    if (!imported) {
      throw new Error('Migration did not retain the draft')
    }
    expect(database.apply([{ kind: 'retain', id: imported.id, expectedRevision: 1 }])).toEqual([
      { id: imported.id, revision: 2 }
    ])
    expect(database.latestActive(metadata())).toBeNull()
    expect(database.read(imported.id)?.content).toBe('unsaved legacy text')
    expect(database.apply([{ kind: 'resolve', id: imported.id, expectedRevision: 1 }])).toEqual([
      { id: imported.id, revision: null }
    ])
    expect(database.apply([put(imported.id, 'stale content', 1)])).toEqual([
      { id: imported.id, revision: null }
    ])
    expect(database.apply([{ kind: 'resolve', id: imported.id, expectedRevision: 2 }])).toEqual([
      { id: imported.id, revision: 3 }
    ])
    database.importLegacy([{ metadata: metadata(), content: 'unsaved legacy text' }])
    expect(database.apply([put(imported.id, 'late creation', 0)])).toEqual([
      { id: imported.id, revision: null }
    ])
    expect(database.list()).toEqual([])
    expect(database.read(imported.id)).toBeNull()
  })

  it('imports idempotently without replacing a newer journal checkpoint', () => {
    const database = fixture().open()
    database.apply([put('current', 'new text')])
    for (let index = 0; index < 3; index++) {
      database.importLegacy([{ metadata: metadata(), content: 'older text' }])
    }
    expect(database.list()).toHaveLength(2)
    expect(database.latestActive(metadata())?.content).toBe('new text')
    expect(database.list().find((entry) => entry.id.startsWith('legacy:'))?.updatedAt).toBe(0)
  })

  it('retires an ID before its first write and preserves distinct unfinished Unicode drafts during migration', () => {
    const database = fixture().open()
    expect(database.apply([{ kind: 'resolve', id: 'saved-first', expectedRevision: 0 }])).toEqual([
      { id: 'saved-first', revision: 1 }
    ])
    expect(database.apply([put('saved-first', 'delayed content', 0)])).toEqual([
      { id: 'saved-first', revision: null }
    ])
    expect(database.status(['saved-first'])).toEqual([
      { id: 'saved-first', revision: 1, state: 'resolved' }
    ])
    database.importLegacy([
      { metadata: metadata(), content: '\ud800' },
      { metadata: metadata(), content: '\ud801' }
    ])
    expect(database.list()).toHaveLength(2)
    expect(new Set(database.list().map((entry) => database.read(entry.id)?.content))).toEqual(
      new Set(['\ud800', '\ud801'])
    )
  })

  it('rolls back every row when a commit fails, then accepts the same pending checkpoint', () => {
    const database = fixture().open()
    database.apply([put('one', 'original')])
    const originalExec = SyncDatabase.prototype.exec
    const fault = vi.spyOn(SyncDatabase.prototype, 'exec').mockImplementation(function (
      this: SyncDatabase,
      sql: string
    ) {
      if (sql === 'COMMIT') {
        throw new Error('disk commit failed')
      }
      originalExec.call(this, sql)
    })
    expect(() => database.apply([put('one', 'changed', 1), put('two', 'second')])).toThrow(
      'disk commit failed'
    )
    expect(database.read('one')).toMatchObject({ content: 'original', revision: 1 })
    expect(database.read('two')).toBeNull()
    fault.mockRestore()
    expect(database.apply([put('one', 'changed', 1), put('two', 'second')])).toEqual([
      { id: 'one', revision: 2 },
      { id: 'two', revision: 1 }
    ])
  })

  it('preserves corrupt and newer journals instead of replacing them with an empty database', () => {
    const f = fixture()
    writeFileSync(f.path, 'irreplaceable damaged journal')
    const corrupt = readFileSync(f.path)
    expect(() => f.open()).toThrow()
    expect(readFileSync(f.path)).toEqual(corrupt)
    rmSync(f.path)
    const newer = new SyncDatabase(f.path)
    newer.exec(
      "CREATE TABLE future_drafts(content TEXT); INSERT INTO future_drafts VALUES ('future text'); PRAGMA user_version = 2"
    )
    newer.close()
    const bytes = readFileSync(f.path)
    expect(() => f.open()).toThrow('newer application version')
    expect(readFileSync(f.path)).toEqual(bytes)
  })
})

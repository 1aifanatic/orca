import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import {
  editorRecoveryDraftSchema,
  editorRecoveryEntrySchema,
  editorRecoveryMetadataSchema,
  editorRecoveryStatusSchema,
  editorRecoveryResourceKey,
  type EditorRecoveryAck,
  type EditorRecoveryChange,
  type EditorRecoveryDraft,
  type EditorRecoveryEntry,
  type EditorRecoveryMetadata
} from '../../shared/editor-recovery'

export class EditorRecoveryDatabase {
  private readonly db: SyncDatabase

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new SyncDatabase(path, { timeout: 5_000 })
    try {
      const version = this.db.pragma('user_version', { simple: true })
      if (version !== 0 && version !== 1) {
        throw new Error('This recovery journal requires a newer application version')
      }
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('synchronous = FULL')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS editor_drafts (
          id TEXT PRIMARY KEY,
          resource_key TEXT NOT NULL,
          metadata TEXT NOT NULL,
          content TEXT,
          revision INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          state TEXT NOT NULL,
          byte_length INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS editor_drafts_resource ON editor_drafts(resource_key, state);
        PRAGMA user_version = 1;
      `)
      hardenSqliteDatabaseFiles(path)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  list(): EditorRecoveryEntry[] {
    return this.db
      .prepare(`SELECT id, metadata, revision, updated_at, state, byte_length
        FROM editor_drafts WHERE state != 'resolved' ORDER BY updated_at DESC, id`)
      .all()
      .map((row) => editorRecoveryEntrySchema.parse(this.projectRow(row)))
  }

  read(id: string): EditorRecoveryDraft | null {
    const row = this.db
      .prepare(`SELECT id, metadata, content, revision, updated_at, state, byte_length
        FROM editor_drafts WHERE id = ? AND state != 'resolved'`)
      .get(id)
    return row ? editorRecoveryDraftSchema.parse(this.projectRow(row)) : null
  }

  latestActive(metadata: EditorRecoveryMetadata): EditorRecoveryDraft | null {
    const row = this.db
      .prepare(`SELECT id, metadata, content, revision, updated_at, state, byte_length
        FROM editor_drafts WHERE resource_key = ? AND state = 'active'
        ORDER BY updated_at DESC, revision DESC LIMIT 1`)
      .get(editorRecoveryResourceKey(metadata))
    return row ? editorRecoveryDraftSchema.parse(this.projectRow(row)) : null
  }
  status(ids: readonly string[]) {
    const query = this.db.prepare('SELECT id, revision, state FROM editor_drafts WHERE id = ?')
    return ids.flatMap((id) => {
      const row = query.get(id)
      return row ? [editorRecoveryStatusSchema.parse(row)] : []
    })
  }

  apply(changes: readonly EditorRecoveryChange[]): EditorRecoveryAck[] {
    return this.transaction(() => changes.map((change) => this.applyChange(change)))
  }

  importLegacy(drafts: readonly { metadata: EditorRecoveryMetadata; content: string }[]): void {
    this.transaction(() => {
      for (const draft of drafts) {
        const key = editorRecoveryResourceKey(draft.metadata)
        const id = `legacy:${createHash('sha256').update(key).update('\0').update(JSON.stringify(draft.content)).digest('hex')}`
        // Keep tombstones so a discarded legacy snapshot cannot return after another migration.
        this.db
          .prepare(`INSERT OR IGNORE INTO editor_drafts
            (id, resource_key, metadata, content, revision, updated_at, state, byte_length)
            VALUES (?, ?, ?, ?, 1, 0, 'active', ?)`)
          .run(
            id,
            key,
            JSON.stringify(draft.metadata),
            JSON.stringify(draft.content),
            Buffer.byteLength(draft.content)
          )
      }
    })
  }

  close(): void {
    this.db.close()
  }

  private applyChange(change: EditorRecoveryChange): EditorRecoveryAck {
    const nextRevision = change.expectedRevision + 1
    const now = Date.now()
    let changed: number | bigint
    if (change.kind === 'put') {
      const metadata = JSON.stringify(change.metadata)
      const key = editorRecoveryResourceKey(change.metadata)
      const bytes = Buffer.byteLength(change.content)
      // JSON preserves every UTF-16 code unit, including an unfinished surrogate pair.
      const content = JSON.stringify(change.content)
      changed =
        change.expectedRevision === 0
          ? this.db
              .prepare(`INSERT OR IGNORE INTO editor_drafts
                (id, resource_key, metadata, content, revision, updated_at, state, byte_length)
                VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
              .run(change.id, key, metadata, content, now, change.state, bytes).changes
          : this.db
              .prepare(`UPDATE editor_drafts SET resource_key = ?, metadata = ?, content = ?,
                revision = ?, updated_at = ?, state = ?, byte_length = ?
                WHERE id = ? AND revision = ? AND state != 'resolved'`)
              .run(
                key,
                metadata,
                content,
                nextRevision,
                now,
                change.state,
                bytes,
                change.id,
                change.expectedRevision
              ).changes
    } else if (change.kind === 'resolve' && change.expectedRevision === 0) {
      // A save may beat the first checkpoint; fence its ID against stale session replay.
      changed = this.db
        .prepare(`INSERT OR IGNORE INTO editor_drafts
        (id, resource_key, metadata, content, revision, updated_at, state, byte_length)
        VALUES (?, '', '{}', NULL, 1, ?, 'resolved', 0)`)
        .run(change.id, now).changes
    } else {
      changed = this.db
        .prepare(`UPDATE editor_drafts SET state = ?, content = CASE WHEN ? = 'resolved'
          THEN NULL ELSE content END, byte_length = CASE WHEN ? = 'resolved' THEN 0 ELSE byte_length END,
          revision = ?, updated_at = ? WHERE id = ? AND revision = ? AND state != 'resolved'`)
        .run(
          change.kind === 'retain' ? 'retained' : 'resolved',
          change.kind === 'retain' ? 'retained' : 'resolved',
          change.kind === 'retain' ? 'retained' : 'resolved',
          nextRevision,
          now,
          change.id,
          change.expectedRevision
        ).changes
    }
    return { id: change.id, revision: Number(changed) === 1 ? nextRevision : null }
  }

  private projectRow(row: Record<string, unknown>): Record<string, unknown> {
    if (typeof row.metadata !== 'string') {
      throw new Error('Invalid recovery metadata')
    }
    return {
      ...editorRecoveryMetadataSchema.parse(JSON.parse(row.metadata)),
      id: row.id,
      content:
        typeof row.content === 'string'
          ? editorRecoveryDraftSchema.shape.content.parse(JSON.parse(row.content))
          : undefined,
      revision: row.revision,
      updatedAt: row.updated_at,
      state: row.state,
      byteLength: row.byte_length
    }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = action()
      this.db.exec('COMMIT')
      hardenSqliteDatabaseFiles(this.path)
      return result
    } catch (error) {
      if (this.db.isTransaction) {
        this.db.exec('ROLLBACK')
      }
      throw error
    }
  }
}

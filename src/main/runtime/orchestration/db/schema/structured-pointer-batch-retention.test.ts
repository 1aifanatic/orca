import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { structuredPointerBatchFingerprint } from '../../structured-pointer-operation-id'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it('keeps operation and exact batch identity across reopening the mailbox database', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-pointer-batch-'))
  roots.push(root)
  const path = join(root, 'mail.db')
  const row = {
    mailbox_handle: 'mailbox',
    session_id: 'session',
    operation_id: 'op',
    batch_fingerprint: structuredPointerBatchFingerprint('session', ['m1', 'm2']),
    minted_at_ms: 1,
    message_ids: ['m1', 'm2']
  }
  const first = new OrchestrationDb(path)
  first.putStructuredPointerOperation(row)
  first.close()
  const reopened = new OrchestrationDb(path)
  try {
    expect(reopened.getStructuredPointerOperation('mailbox')).toEqual(row)
  } finally {
    reopened.close()
  }
})

it.each([43, 44])(
  'repairs schema %s without inventing membership or changing legacy ids',
  (version) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-pointer-upgrade-'))
    roots.push(root)
    const path = join(root, 'mail.db')
    const row = {
      mailbox_handle: 'mailbox',
      session_id: 'session',
      operation_id: 'legacy',
      batch_fingerprint: 'fp',
      minted_at_ms: 1
    }
    const first = new OrchestrationDb(path)
    first.putStructuredPointerOperation(row)
    first.db.exec('ALTER TABLE structured_pointer_operations DROP COLUMN message_ids_json')
    first.db.pragma(`user_version = ${version}`)
    first.close()
    const reopened = new OrchestrationDb(path)
    try {
      expect(reopened.getStructuredPointerOperation('mailbox')).toEqual(row)
      reopened.putStructuredPointerOperation({
        ...row,
        batch_fingerprint: structuredPointerBatchFingerprint('session', ['m1']),
        message_ids: ['m1']
      })
      expect(reopened.getStructuredPointerOperation('mailbox')?.message_ids).toEqual(['m1'])
    } finally {
      reopened.close()
    }
  }
)

it('does not adopt stale membership when an older writer replaces an operation', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    db.putStructuredPointerOperation({
      mailbox_handle: 'm',
      session_id: 's',
      operation_id: 'old',
      batch_fingerprint: structuredPointerBatchFingerprint('s', ['old-mail']),
      minted_at_ms: 1,
      message_ids: ['old-mail']
    })
    db.db
      .prepare(
        'UPDATE structured_pointer_operations SET operation_id = ?, batch_fingerprint = ? WHERE mailbox_handle = ?'
      )
      .run('new', structuredPointerBatchFingerprint('s', ['new-mail']), 'm')
    expect(db.getStructuredPointerOperation('m')).toMatchObject({ operation_id: 'new' })
    expect(db.getStructuredPointerOperation('m')?.message_ids).toBeUndefined()
  } finally {
    db.close()
  }
})

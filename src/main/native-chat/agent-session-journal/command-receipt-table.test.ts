import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import {
  commandReceiptScope,
  commandReceiptScopeKey,
  type CommandReceipt
} from './command-receipt-schema'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './command-receipt-table'
import {
  commandReceiptFixture,
  writeCommandReceiptTestRecord
} from './command-receipt-test-support'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'

let root: string
let database: JournalHostDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-command-receipt-table-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => writeCommandReceiptTestRecord(db))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function insert(receipt: CommandReceipt) {
  return database.transaction((db) => insertCommandReceiptIfAbsent(db, receipt))
}

function read(receipt: CommandReceipt) {
  return readCommandReceipt(database.db, receipt.scope, receipt.operationId)
}

describe('command receipt identity', () => {
  it('inserts once and returns the established receipt on a duplicate', () => {
    const receipt = commandReceiptFixture()
    expect(read(receipt)).toEqual({ verdict: 'absent' })
    expect(insert(receipt)).toEqual({ inserted: true })
    expect(insert({ ...receipt, acceptedAt: 2000, callerKey: 'caller-2' })).toEqual({
      inserted: false,
      reason: 'duplicate',
      existing: { verdict: 'readable', receipt }
    })
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it('reports a changed canonical hash, including a different method or chat, as conflict', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.transaction((db) => writeCommandReceiptTestRecord(db, 'session-2'))
    for (const target of [
      { method: 'agentSession.cancel', sessionId: 'session-1' },
      { method: 'agentSession.send', sessionId: 'session-2' }
    ]) {
      const changed = commandReceiptFixture({
        ...target,
        fingerprint: computeAgentSessionPayloadFingerprint({ ...target, fields: {} })
      })
      expect(insert(changed)).toEqual({
        inserted: false,
        reason: 'conflict',
        existing: { verdict: 'readable', receipt }
      })
    }
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it('isolates global and caller namespaces without scope string collisions', () => {
    const receipts = [
      commandReceiptFixture(),
      commandReceiptFixture({ scope: commandReceiptScope('caller-1') }),
      commandReceiptFixture({ scope: commandReceiptScope('caller-2'), callerKey: 'caller-2' }),
      commandReceiptFixture({ scope: commandReceiptScope('global'), callerKey: 'global' })
    ]
    for (const receipt of receipts) {
      expect(insert(receipt)).toEqual({ inserted: true })
      expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
    }
  })

  it('refuses a caller that does not match its namespace', () => {
    const receipt = commandReceiptFixture({ scope: commandReceiptScope('caller-2') })
    expect(() => insert(receipt)).toThrow('command caller does not match its scope')
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })

  it('requires the chat record to exist and does not leave an orphan receipt', () => {
    const receipt = commandReceiptFixture({ sessionId: 'missing-chat' })
    expect(() => insert(receipt)).toThrow(/FOREIGN KEY/i)
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })

  it('requires an effect transaction instead of committing a preliminary reservation', () => {
    const receipt = commandReceiptFixture()
    expect(() => insertCommandReceiptIfAbsent(database.db, receipt)).toThrow(/effect transaction/)
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })
})

describe('command receipt outcomes and lifetime', () => {
  it.each([
    { kind: 'cancel', cancelled: false, turnId: 'turn-1' },
    { kind: 'cancel', cancelled: false },
    { kind: 'queue-resume', resumed: false }
  ] as const)('reads the small no-op outcome $kind', (outcome) => {
    const receipt = commandReceiptFixture({ result: { kind: 'no-op', outcome } })
    insert(receipt)
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
  })

  it('retains a refused outcome with its code, message and details', () => {
    const { result: _result, ...identity } = commandReceiptFixture()
    const receipt: CommandReceipt = {
      ...identity,
      status: 'rejected',
      rejection: {
        reference: { code: 'agent_session_operation_invalid', details: { reason: 'promptGone' } },
        message: 'The prompt is no longer available.'
      }
    }
    insert(receipt)
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
    expect(insert(commandReceiptFixture())).toMatchObject({ inserted: false, reason: 'duplicate' })
  })

  it('preserves receipts across record upserts and cascades only on record deletion', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.transaction((db) => writeCommandReceiptTestRecord(db, 'session-1', '{"updated":true}'))
    expect(read(receipt)).toEqual({ verdict: 'readable', receipt })
    database.transaction((db) => writeCommandReceiptTestRecord(db, 'session-1', null))
    expect(read(receipt)).toEqual({ verdict: 'absent' })
  })
})

describe('unreadable command receipts', () => {
  it.each([
    ['result_json', '{'],
    ['result_json', '{"kind":"journal-row","epoch":"e1","sequence":0}'],
    ['result_json', '{"kind":"future-result"}'],
    ['result_json', null],
    ['status', 'pending'],
    ['method', ''],
    ['fingerprint', ''],
    ['accepted_at', -1],
    ['caller_key', ''],
    ['rejection_json', '{}']
  ])('preserves the key when %s holds malformed data %s', (column, value) => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.db.prepare(`UPDATE agent_session_command_receipts SET ${column} = ?`).run(value)
    const existing = {
      verdict: 'unreadable',
      scope: receipt.scope,
      operationId: receipt.operationId
    }
    expect(read(receipt)).toEqual(existing)
    expect(insert(receipt)).toEqual({ inserted: false, reason: 'unreadable', existing })
  })

  it('treats a malformed rejection as unreadable rather than granting another execution', () => {
    const receipt = commandReceiptFixture()
    insert(receipt)
    database.db
      .prepare(`UPDATE agent_session_command_receipts SET status = 'rejected', result_json = NULL,
        rejection_json = ? WHERE scope = ? AND operation_id = ?`)
      .run(
        JSON.stringify({
          reference: { code: 'agent_session_operation_invalid', details: { reason: 'madeUp' } }
        }),
        commandReceiptScopeKey(receipt.scope),
        receipt.operationId
      )
    expect(read(receipt)).toMatchObject({ verdict: 'unreadable' })
    expect(insert(receipt)).toMatchObject({ inserted: false, reason: 'unreadable' })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createOrchestrationRetryRequestId,
  ORCHESTRATION_RETRY_WINDOW_MS
} from '../../../shared/orchestration-retry-request-id'
import { OrchestrationDb } from './db'
import { insertMutationReceiptIfAbsent } from './db/mutation-receipts/mutation-receipt-insert'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const identity = (requestId: string) => ({
  callerFingerprint: 'caller',
  requestId,
  method: 'orchestration.send',
  payloadHash: 'hash'
})

describe('mutation receipt admission', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => {
    db?.close()
    vi.restoreAllMocks()
  })

  it('requires an existing transaction and leaves commit and rollback to its caller', () => {
    const store = new OrchestrationDb(':memory:')
    db = store
    const input = identity(createOrchestrationRetryRequestId())
    expect(() => insertMutationReceiptIfAbsent(store, input)).toThrow('open transaction')
    store.db.exec('BEGIN IMMEDIATE')
    expect(insertMutationReceiptIfAbsent(store, input)).toEqual({ inserted: true })
    expect(store.db.isTransaction).toBe(true)
    expect(insertMutationReceiptIfAbsent(store, input)).toMatchObject({
      inserted: false,
      reason: 'duplicate',
      existing: { request_id: input.requestId }
    })
    expect(
      insertMutationReceiptIfAbsent(store, { ...input, payloadHash: 'different' })
    ).toMatchObject({
      inserted: false,
      reason: 'conflict'
    })
    expect(
      insertMutationReceiptIfAbsent(store, { ...input, method: 'orchestration.reply' })
    ).toMatchObject({
      inserted: false,
      reason: 'conflict'
    })
    expect(insertMutationReceiptIfAbsent(store, { ...input, callerFingerprint: 'other' })).toEqual({
      inserted: true
    })
    store.db.exec('ROLLBACK')
    expect(store.getMutationReceipt('caller', input.requestId)).toBeUndefined()
  })

  it('admits current, exact-window, future and legacy ids and stores only v7 issue times', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new OrchestrationDb(':memory:')
    for (const time of [
      NOW,
      NOW - ORCHESTRATION_RETRY_WINDOW_MS,
      NOW + ORCHESTRATION_RETRY_WINDOW_MS
    ]) {
      const input = identity(createOrchestrationRetryRequestId(time))
      expect(db.beginMutationReceipt(input)).toMatchObject({
        disposition: 'started',
        row: { request_issued_at_ms: time }
      })
      expect(db.beginMutationReceipt(input)).toMatchObject({ disposition: 'pending' })
      expect(() => db?.beginMutationReceipt({ ...input, payloadHash: 'changed' })).toThrowError(
        expect.objectContaining({ code: 'request_mismatch' })
      )
    }
    expect(db.beginMutationReceipt(identity('11111111-2222-4333-8444-555555555555'))).toMatchObject(
      {
        disposition: 'started',
        row: { request_issued_at_ms: null }
      }
    )
  })

  it.each(['host window', 'retirement boundary'])('refuses an absent id below the %s', (source) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new OrchestrationDb(':memory:')
    const issuedAt = source === 'host window' ? NOW - ORCHESTRATION_RETRY_WINDOW_MS - 1 : NOW - 1000
    if (source === 'retirement boundary') {
      db.db.prepare('UPDATE mutation_receipt_retirement SET retired_before_ms = ?').run(NOW)
    }
    const input = identity(createOrchestrationRetryRequestId(issuedAt))
    expect(() => db?.beginMutationReceipt(input)).toThrowError(
      expect.objectContaining({
        code: 'operation_unknown',
        data: { requestId: input.requestId },
        message: expect.stringContaining('without --retry-request')
      })
    )
    expect(db.getMutationReceipt('caller', input.requestId)).toBeUndefined()
    expect(db.db.isTransaction).toBe(false)
  })

  it('replays present old rows even below the boundary and detects changed inputs', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW)
    db = new OrchestrationDb(':memory:')
    const input = identity(createOrchestrationRetryRequestId(NOW))
    db.beginMutationReceipt(input)
    db.completeMutationReceipt({ ...input, receipt: '{"accepted":true}' })
    clock.mockReturnValue(NOW + 2 * ORCHESTRATION_RETRY_WINDOW_MS)
    db.db.prepare('UPDATE mutation_receipt_retirement SET retired_before_ms = ?').run(NOW + 1)
    expect(db.beginMutationReceipt(input)).toMatchObject({
      disposition: 'completed',
      row: { receipt: '{"accepted":true}' }
    })
    expect(() =>
      db?.beginMutationReceipt({ ...input, method: 'orchestration.reply' })
    ).toThrowError(expect.objectContaining({ code: 'request_mismatch' }))
    expect(() => db?.beginMutationReceipt({ ...input, callerFingerprint: 'other' })).toThrowError(
      expect.objectContaining({ code: 'operation_unknown' })
    )
  })

  it.each(['worker', 'remote'])('refuses an expired %s before durable work is created', (kind) => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const store = new OrchestrationDb(':memory:')
    db = store
    const input = identity(
      createOrchestrationRetryRequestId(NOW - ORCHESTRATION_RETRY_WINDOW_MS - 1)
    )
    const accept = () =>
      kind === 'worker'
        ? store.createStartingWorkerDispatch({
            creator: { kind: 'system' },
            maxDepth: 10,
            taskSpec: 'must not exist',
            taskRunId: 'run_legacy_local',
            startOptions: {},
            mutationReceipt: input
          })
        : store.createRemoteDispatchAttachment({
            dispatchId: 'remote',
            runId: 'new-run',
            taskId: 'task',
            homePeerFingerprint: 'caller',
            protocolVersion: 1,
            runtimeEpoch: 'epoch',
            mutationReceipt: input
          })
    expect(accept).toThrowError(expect.objectContaining({ code: 'operation_unknown' }))
    expect(store.getMutationReceipt('caller', input.requestId)).toBeUndefined()
    expect(
      store.db.prepare("SELECT 1 FROM tasks WHERE spec = 'must not exist'").get()
    ).toBeUndefined()
    expect(store.getRemoteDispatchAttachment('remote')).toBeUndefined()
    expect(store.db.prepare("SELECT 1 FROM runs WHERE id = 'new-run'").get()).toBeUndefined()
  })
})

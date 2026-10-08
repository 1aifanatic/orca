import type Database from '../../sqlite/sync-database'
import { ORCHESTRATION_RETRY_WINDOW_MS } from '../../../shared/orchestration-retry-request-id'

const PRUNE_BATCH_SIZE = 256
const MAX_BATCHES_PER_RUN = 100
export const RETIRE_MUTATION_RECEIPT_BATCH_SQL = `DELETE FROM mutation_receipts
  WHERE rowid IN (
    SELECT rowid FROM mutation_receipts
    WHERE request_issued_at_ms < (
      SELECT retired_before_ms FROM mutation_receipt_retirement WHERE singleton = 1
    )
    ORDER BY request_issued_at_ms, rowid LIMIT ?
  )`

export type MutationReceiptMaintenance = { stop: () => void }

export function startMutationReceiptMaintenance(
  db: Database.Database,
  options: { initialDelayMs: number; intervalMs: number; onError: (error: unknown) => void }
): MutationReceiptMaintenance {
  let stopped = false
  let running = false
  const run = (): void => {
    if (stopped || running) {
      return
    }
    running = true
    void retireMutationReceipts(db, () => stopped)
      .catch(options.onError)
      .finally(() => {
        running = false
      })
  }
  const initial = setTimeout(run, options.initialDelayMs)
  const interval = setInterval(run, options.intervalMs)
  initial.unref?.()
  interval.unref?.()
  return {
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    }
  }
}

export async function retireMutationReceipts(
  db: Database.Database,
  isStopped: () => boolean = () => false
): Promise<void> {
  if (isStopped()) {
    return
  }
  withNoBusyWait(db, () => {
    db.prepare(`UPDATE mutation_receipt_retirement
      SET retired_before_ms = max(retired_before_ms, ?) WHERE singleton = 1`).run(
      Date.now() - ORCHESTRATION_RETRY_WINDOW_MS
    )
  })
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN && !isStopped(); batch++) {
    const removed = withNoBusyWait(db, () =>
      db.prepare(RETIRE_MUTATION_RECEIPT_BATCH_SQL).run(PRUNE_BATCH_SIZE)
    )
    if (removed.changes < PRUNE_BATCH_SIZE) {
      break
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function withNoBusyWait<T>(db: Database.Database, write: () => T): T {
  const timeout = db.pragma('busy_timeout', { simple: true })
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0) {
    throw new Error('Invalid SQLite busy timeout')
  }
  // Maintenance yields to another writer instead of parking the event loop.
  db.pragma('busy_timeout = 0')
  try {
    return write()
  } finally {
    db.pragma(`busy_timeout = ${timeout}`)
  }
}

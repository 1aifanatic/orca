import type Database from '../../sqlite/sync-database'

const MAINTENANCE_INTERVAL_MS = 60_000
const COMPLETED_RECEIPT_MAX_AGE_DAYS = 30
const PRUNE_BATCH_SIZE = 256

export function startMutationReceiptMaintenance(db: Database.Database): () => void {
  const timer = setInterval(() => {
    try {
      pruneExpiredMutationReceipts(db)
    } catch (error) {
      console.warn('[orchestration] expired mutation receipt cleanup failed', error)
    }
  }, MAINTENANCE_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

function pruneExpiredMutationReceipts(db: Database.Database): void {
  const busyTimeout = db.pragma('busy_timeout', { simple: true })
  if (typeof busyTimeout !== 'number' || !Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
    throw new Error('Invalid SQLite busy timeout')
  }
  // Maintenance yields to another writer instead of parking the runtime's event loop.
  db.pragma('busy_timeout = 0')
  try {
    db.prepare(
      `DELETE FROM mutation_receipts
       WHERE rowid IN (
         SELECT rowid FROM mutation_receipts
         WHERE state = 'completed'
           AND updated_at < datetime('now', ?)
         ORDER BY updated_at ASC, rowid ASC
         LIMIT ?
       )`
    ).run(`-${COMPLETED_RECEIPT_MAX_AGE_DAYS} days`, PRUNE_BATCH_SIZE)
  } finally {
    db.pragma(`busy_timeout = ${busyTimeout}`)
  }
}

import type { OrchestrationDb } from '../orchestration-db'

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  if (!this.hasColumn('mutation_receipts', 'request_issued_at_ms')) {
    this.db.exec('ALTER TABLE mutation_receipts ADD COLUMN request_issued_at_ms INTEGER')
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mutation_receipts_issued_at
      ON mutation_receipts(request_issued_at_ms) WHERE request_issued_at_ms IS NOT NULL;
    CREATE TABLE IF NOT EXISTS mutation_receipt_retirement (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      retired_before_ms INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO mutation_receipt_retirement VALUES (1, 0);
  `)
}

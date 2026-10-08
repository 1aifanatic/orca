import type { OrchestrationDb } from '../orchestration-db'

export function migrateV44(this: OrchestrationDb): void {
  const columns = this.db.prepare('PRAGMA table_info(structured_pointer_operations)').all()
  if (
    !columns.some(
      (column) =>
        typeof column === 'object' &&
        column !== null &&
        'name' in column &&
        column.name === 'message_ids_json'
    )
  ) {
    this.db.exec('ALTER TABLE structured_pointer_operations ADD COLUMN message_ids_json TEXT')
  }
}

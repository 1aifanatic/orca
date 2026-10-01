import { BoundedMap } from './bounded-map'
import type { RefMaintenanceOutcome, RefMaintenanceSpan } from './repo-ref-maintenance-policy'

export class RepoRefMaintenanceCooldown {
  private readonly cooldownUntil = new BoundedMap<string, number>({ maxEntries: 256 })

  constructor(private readonly now: () => number) {}

  dueAt(key: string): number {
    return this.cooldownUntil.peek(key) ?? 0
  }

  clear(): void {
    this.cooldownUntil.clear()
  }

  settle(
    key: string,
    span: RefMaintenanceSpan,
    outcome: RefMaintenanceOutcome,
    cooldownMs: number
  ): void {
    span.setAttribute('repo.maintenance_outcome', outcome)
    this.cooldownUntil.set(key, this.now() + cooldownMs)
  }
}

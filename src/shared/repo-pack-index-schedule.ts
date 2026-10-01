import { BoundedMap } from './bounded-map'
import {
  PACK_INDEX_MAINTENANCE_COOLDOWN_MS,
  PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS,
  type PackIndexMaintenanceOutcome
} from './repo-pack-index-maintenance-policy'
import {
  REF_MAINTENANCE_CLEAN_COOLDOWN_MS,
  type RefMaintenanceSpan,
  type RepoRefMaintenanceTarget
} from './repo-ref-maintenance-policy'

export class RepoPackIndexSchedule {
  private readonly cooldownUntil = new BoundedMap<string, number>({ maxEntries: 256 })

  constructor(private readonly now: () => number) {}

  dueAt(key: string): number {
    return this.cooldownUntil.get(key) ?? 0
  }

  postpone(key: string, cooldownMs: number): void {
    this.cooldownUntil.set(key, this.now() + cooldownMs)
  }

  clear(): void {
    this.cooldownUntil.clear()
  }

  async maintain(
    target: RepoRefMaintenanceTarget,
    signal: AbortSignal,
    span: RefMaintenanceSpan,
    canWrite: () => boolean
  ): Promise<PackIndexMaintenanceOutcome | void> {
    if (!target.maintainPackIndex || this.now() < this.dueAt(target.key)) {
      return
    }
    const outcome = await target.maintainPackIndex(signal, span, canWrite)
    if (signal.aborted || outcome === 'deferred') {
      return outcome
    }
    const cooldown =
      outcome === 'failed'
        ? PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS
        : outcome === 'opted_out' || outcome === 'protected'
          ? REF_MAINTENANCE_CLEAN_COOLDOWN_MS
          : PACK_INDEX_MAINTENANCE_COOLDOWN_MS
    this.postpone(target.key, cooldown)
    return outcome
  }
}

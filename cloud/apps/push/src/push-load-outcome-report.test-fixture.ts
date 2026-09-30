import type { SlotKind } from './push-load-database-instrumentation.test-fixture.js'
import type { LoadRun } from './push-load-run.test-fixture.js'

const MINUTE_MS = 60_000

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null
}

type SlotTotals = Record<SlotKind, { holdMs: number; waitMs: number; count: number }>
const emptySlotTotals = (): SlotTotals => ({
  claim: { holdMs: 0, waitMs: 0, count: 0 },
  finish: { holdMs: 0, waitMs: 0, count: 0 },
  prune: { holdMs: 0, waitMs: 0, count: 0 },
  other: { holdMs: 0, waitMs: 0, count: 0 }
})

export type MinuteReport = {
  minute: number
  enqueued: number
  delivered: number
  expiredAtDispatch: number
  expiredUnclaimed: number
  p50DeliveryMs: number | null
  p95DeliveryMs: number | null
  p50CycleMs: number | null
  slot: SlotTotals
  pruneRowsDeleted: Record<string, number>
}

// Buckets each outcome by the minute it happened in; an unclaimed item lands in its expiry minute.
export function reportLoadRun(run: LoadRun) {
  const minutes = Math.ceil((run.stoppedAt - run.startedAt) / MINUTE_MS)
  const bucket = (at: number) => Math.floor((at - run.startedAt) / MINUTE_MS)
  const rows: MinuteReport[] = Array.from({ length: minutes }, (_, minute) => ({
    minute,
    enqueued: 0,
    delivered: 0,
    expiredAtDispatch: 0,
    expiredUnclaimed: 0,
    p50DeliveryMs: null,
    p95DeliveryMs: null,
    p50CycleMs: null,
    slot: emptySlotTotals(),
    pruneRowsDeleted: {}
  }))
  const latencies: number[][] = rows.map(() => [])
  const cycles: number[][] = rows.map(() => [])
  const allCycles: number[] = []
  const allLatencies: number[] = []
  let inFlightAtStop = 0
  let claimedItems = 0
  for (const item of run.items.values()) {
    const row = (at: number) => rows[bucket(at)]
    if (!item.seeded) row(item.enqueuedAt)!.enqueued++
    if (item.claimedAt !== undefined) claimedItems++
    if (item.cycleMs !== undefined && item.claimedAt !== undefined) {
      cycles[bucket(item.claimedAt)]?.push(item.cycleMs)
      allCycles.push(item.cycleMs)
    }
    if (item.deliveredAt !== undefined && item.deliveredAt <= run.stoppedAt) {
      const target = row(item.deliveredAt)
      if (target) target.delivered++
      if (!item.seeded) {
        latencies[bucket(item.deliveredAt)]?.push(item.deliveredAt - item.enqueuedAt)
        allLatencies.push(item.deliveredAt - item.enqueuedAt)
      }
    } else if (item.expiredAtDispatchAt !== undefined && item.expiredAtDispatchAt <= run.stoppedAt) {
      const target = row(item.expiredAtDispatchAt)
      if (target) target.expiredAtDispatch++
    } else if (item.expiresAt <= run.stoppedAt) {
      const target = row(Math.max(run.startedAt, item.expiresAt))
      if (target) target.expiredUnclaimed++
    } else inFlightAtStop++
  }
  rows.forEach((row, minute) => {
    row.p50DeliveryMs = percentile(latencies[minute]!, 50)
    row.p95DeliveryMs = percentile(latencies[minute]!, 95)
    row.p50CycleMs = percentile(cycles[minute]!, 50)
  })
  const totals = emptySlotTotals()
  for (const sample of run.ledger.samples) {
    const row = rows[bucket(sample.endedAt)]
    for (const slot of row ? [row.slot, totals] : [totals]) {
      slot[sample.kind].holdMs += sample.endedAt - sample.admittedAt
      slot[sample.kind].waitMs += sample.admittedAt - sample.requestedAt
      slot[sample.kind].count++
    }
    if (row && sample.kind === 'prune' && sample.table)
      row.pruneRowsDeleted[sample.table] = (row.pruneRowsDeleted[sample.table] ?? 0) + (sample.changes ?? 0)
  }
  // Includes claim transactions that came back empty, so it is the full worker cost per claimed item.
  const perItemSlotMs = claimedItems
    ? (totals.claim.holdMs + totals.finish.holdMs) / claimedItems
    : null
  const capacity = Math.max(1, run.config.poolMax - 1)
  return {
    label: run.config.label,
    config: run.config,
    eligibleAtStart: run.eligibleAtStart,
    durationMs: run.stoppedAt - run.startedAt,
    acceptFailures: run.acceptFailures,
    acceptP95Ms: percentile(run.acceptLatenciesMs, 95),
    inFlightAtStop,
    p50DeliveryMs: percentile(allLatencies, 50),
    p95DeliveryMs: percentile(allLatencies, 95),
    slotTotals: totals,
    claimedItems,
    p50CycleMs: percentile(allCycles, 50),
    p95CycleMs: percentile(allCycles, 95),
    perItemSlotMs,
    workerCeilingPerSecond: perItemSlotMs ? (1000 * capacity) / perItemSlotMs : null,
    minutes: rows
  }
}

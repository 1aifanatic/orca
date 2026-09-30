import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reportLoadRun } from './push-load-outcome-report.test-fixture.js'
import { runLoad, type LoadConfig } from './push-load-run.test-fixture.js'
import type { PruneScheduler } from './push-load-prune-schedulers.test-fixture.js'

// Opt-in load reproduction of the 2026-09-30 delivery collapse; minutes of real time per config.
const adminUrl = process.env.ORCA_PUSH_LOAD_POSTGRES_URL
const numberFromEnv = (name: string, fallback: number) => Number(process.env[name] ?? fallback)

const base = {
  durationMs: numberFromEnv('ORCA_PUSH_LOAD_DURATION_MS', 6 * 60_000),
  deliveriesPerSecond: numberFromEnv('ORCA_PUSH_LOAD_RATE', 30),
  rttMs: numberFromEnv('ORCA_PUSH_LOAD_RTT_MS', 0),
  pruneFullBatchMs: numberFromEnv('ORCA_PUSH_LOAD_PRUNE_FULL_BATCH_MS', 0),
  providerLatencyMs: 100,
  population: { hosts: 600, devicesPerHost: 3 },
  retention: {
    eventsPerSecond: numberFromEnv('ORCA_PUSH_LOAD_RETENTION_RATE', 30),
    dismissalsPerSecond: numberFromEnv('ORCA_PUSH_LOAD_DISMISSAL_RATE', 10),
    eligibleBacklogMs: numberFromEnv('ORCA_PUSH_LOAD_ELIGIBLE_BACKLOG_MS', 0)
  },
  pending: {
    backlogMs: numberFromEnv('ORCA_PUSH_LOAD_PENDING_BACKLOG_MS', 5 * 60_000),
    perSecond: numberFromEnv('ORCA_PUSH_LOAD_RATE', 30)
  }
} satisfies Omit<LoadConfig, 'label' | 'poolMax' | 'scheduler'>

const configurations: Record<string, { poolMax: number; scheduler: PruneScheduler }> = {
  A: { poolMax: 2, scheduler: 'interval' },
  B: { poolMax: 2, scheduler: 'chained' },
  C: { poolMax: 6, scheduler: 'chained' },
  D: { poolMax: 2, scheduler: 'none' }
}
const selected = (process.env.ORCA_PUSH_LOAD_CONFIGS ?? 'A,B,C,D').split(',')

describe.skipIf(!adminUrl)('push worker single-connection load', () => {
  for (const label of selected) {
    it(`configuration ${label}`, { timeout: base.durationMs + 20 * 60_000 }, async () => {
      const shape = configurations[label]
      if (!shape) throw new Error(`unknown configuration ${label}`)
      const run = await runLoad(adminUrl!, { ...base, ...shape, label })
      const report = reportLoadRun(run)
      const directory = process.env.ORCA_PUSH_LOAD_RESULT_DIR
      if (directory) {
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, `${label}.json`), JSON.stringify(report, null, 2))
      }
      console.log(JSON.stringify({ event: 'push_load_report', ...report, minutes: undefined }))
      for (const minute of report.minutes)
        console.log(
          JSON.stringify({
            event: 'push_load_minute',
            label,
            ...minute,
            slot: Object.fromEntries(
              Object.entries(minute.slot).map(([kind, { holdMs, waitMs, count }]) => [
                kind,
                `${count} stmts, hold ${Math.round(holdMs)} ms, wait ${Math.round(waitMs)} ms`
              ])
            )
          })
        )
      expect(report.minutes.length).toBeGreaterThan(0)
    })
  }
})

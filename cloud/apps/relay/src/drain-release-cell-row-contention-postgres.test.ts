import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership,
  type CellAdmissionState
} from './cell-admission-selector.js'
import type { RelayCellConfig } from './config.js'
import {
  consumeRelayCellInventoryHold,
  consumeRelayDatabasePoolPressure,
  openRelayDatabase,
  type RelayDatabase
} from './database.js'
import { RelayPublicAssignmentAdmission } from './public-assignment-admission.js'
import {
  openDelayedPostgresDatabase,
  type StatementDelay
} from './test-fixtures/delayed-postgres-database.js'

// Reproduces the Asia drain brownout: a draining cell's releases each end with
// a one-row UPDATE of the source relay_cells row, held for a round trip to
// COMMIT, while every director's re-placement of reconnecting hosts needs all
// relay_cells rows. Prints one line per run and asserts the before picture.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// asia-east2 cell to the us-central1 database, measured in production.
const ASIA_ROUND_TRIP_MS = 171
const LOCAL_ROUND_TRIP_MS = 1
const WINDOW_MS = 10_000
// Reconnecting hosts dialling the directors during the window. Above the
// ~6-15/s the production tail sustained, so the director side is never idle.
const DIAL_RATE_PER_SECOND = 20
// Production shapes: five director instances (production.tfvars), each with
// the default pool and sticky lane (variables.tf, config.ts), and an Asia
// cell's pool (validate-relay-asia-topology-plan.mjs).
const DIRECTOR_INSTANCES = 5
const DIRECTOR_POOL_MAX = 3
const STICKY_LANE = { maxConcurrent: 1, maxQueued: 64, waitMs: 2_000, minIntervalMs: 2_000 }
const CELL_POOL_MAX = 16
const DIRECTOR_APPLICATION = 'drain-release-contention-director'

const USER_PREFIX = 'drain-release-contention'
const NOW = 1_000_000
const CAPPED = {
  capacityRequests: 6_000,
  connectionHardCap: 3_000,
  connectionUnobservedBound: 60
} as const
const SOURCE: RelayCellConfig = {
  id: 'drain-release-contention-a-source',
  url: 'https://drain-release-contention-source.example.test',
  region: 'asia-east2',
  ...CAPPED
}
const TARGETS: RelayCellConfig[] = ['b', 'c', 'd'].map((suffix) => ({
  id: `drain-release-contention-${suffix}-target`,
  url: `https://drain-release-contention-${suffix}-target.example.test`,
  region: 'asia-east2',
  ...CAPPED
}))
const CELLS = [SOURCE, ...TARGETS]
const RELEASED_ACTIVITY = `control:${SOURCE.id}:1`

type Identity = { userId: string; relayHostId: string }
type Tally = Record<string, number>
type Instance = { database: RelayDatabase; store: RelayAssignmentStore }

type RunReport = {
  roundTripMs: number
  releaseRate: number
  releases: { attempted: number; ok: number; failed: Tally; p50Ms: number; p95Ms: number }
  dials: {
    attempted: number
    placed: number
    placedInWindow: number
    admissionRejected: Tally
    failed: Tally
  }
  activations: { ok: number; failed: Tally }
  placementsPerSecond: number
  director: {
    lockUnavailable: number
    lockTimeouts: number
    holds: number
    holdMsMax: number
    // Mean director backends blocked on a lock per 20ms sample, of those active.
    lockWaitingMean: number
    activeMean: number
  }
  sourcePoolWaitersMax: number
}

function hostIdentity(index: number): Identity {
  return {
    userId: `${USER_PREFIX}-${index}`,
    // Relay host ids are fixed-width opaque ids.
    relayHostId: `drainrel${String(index).padStart(8, '0')}`
  }
}

function failureCode(error: unknown): string {
  if (error instanceof Error) {
    const code = 'code' in error ? error.code : undefined
    return typeof code === 'string' ? code : error.message
  }
  return String(error)
}

function count(tally: Tally, key: string): void {
  tally[key] = (tally[key] ?? 0) + 1
}

function total(tally: Tally): number {
  return Object.values(tally).reduce((sum, value) => sum + value, 0)
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!)
}

function mean(sum: number, samples: number): number {
  return samples === 0 ? 0 : Number((sum / samples).toFixed(2))
}

// Fires `operation` at a fixed rate without awaiting it, like independent
// socket closes or dials would.
async function paced<T>(
  ratePerSecond: number,
  total: number,
  operation: (index: number) => Promise<T>
): Promise<Promise<T>[]> {
  const startedAt = performance.now()
  const started: Promise<T>[] = []
  for (let index = 0; index < total; index += 1) {
    const dueMs = (index * 1_000) / ratePerSecond - (performance.now() - startedAt)
    if (dueMs > 0) await new Promise((resolve) => setTimeout(resolve, dueMs))
    started.push(operation(index))
  }
  return started
}

describePostgres('PostgreSQL drain releases against director placement', () => {
  const storeOptions = { requireLiveCells: true, heartbeatTtlMs: 45_000 }
  // One switch for every Asia pool: the source cell and each target cell.
  const delay: StatementDelay = { enabled: false, delayMs: LOCAL_ROUND_TRIP_MS }
  const directors: Instance[] = []
  const asiaCells = new Map<string, Instance>()
  let observer: RelayDatabase
  const reports: RunReport[] = []

  function admin(): Instance {
    return directors[0]!
  }

  function asiaCell(cellId: string): Instance {
    const instance = asiaCells.get(cellId)
    if (!instance) throw new Error(`no Asia pool for ${cellId}`)
    return instance
  }

  async function applySelector(
    states: Record<string, CellAdmissionState>,
    rollIsolatedCells?: string[]
  ): Promise<void> {
    const current = await admin().store.inspectCellAdmissionSelector()
    // Built from relay_cells: the apply requires exact coverage of a shared fleet.
    const fleet = await admin().database.query(
      `SELECT cell_id FROM relay_cells ORDER BY cell_id ASC`
    )
    const membership: CellAdmissionMembership = {
      existingOnly: [],
      migrationOnly: [],
      general: []
    }
    for (const row of fleet) {
      const cellId = String(row['cell_id'])
      const state =
        states[cellId] ??
        (current.selector.membership.existingOnly.includes(cellId)
          ? 'existing-only'
          : current.selector.membership.migrationOnly.includes(cellId)
            ? 'migration-only'
            : 'general')
      if (state === 'existing-only') membership.existingOnly.push(cellId)
      else if (state === 'migration-only') membership.migrationOnly.push(cellId)
      else membership.general.push(cellId)
    }
    await admin().store.applyCellAdmissionSelector({
      attemptId: `drain-release-${current.selector.generation}`,
      expectedGeneration: current.selector.generation,
      ...(current.selector.generation === 0
        ? {
            expectedMembershipSha256: createHash('sha256')
              .update(encodeMembership(current.selector.membership))
              .digest('hex')
          }
        : {}),
      membership,
      ...(rollIsolatedCells ? { rollIsolatedCells } : {})
    })
  }

  // Other Postgres files write admission through the generation-0 helpers, so
  // the selector goes back to generation 0 exactly as found.
  async function resetSelectorBoundary(): Promise<void> {
    await admin().database.query(
      `UPDATE relay_admission_selectors SET generation = 0, attempt_id = NULL
       WHERE selector_id = 'general'`
    )
    await admin().database.query(
      `DELETE FROM relay_admission_selector_intents WHERE attempt_id LIKE 'drain-release-%'`
    )
    await admin().store.reconcileCells([], false)
  }

  async function deleteHostRows(): Promise<void> {
    for (const table of [
      'relay_control_capabilities',
      'relay_control_connection_reservations',
      'relay_assignment_activity_leases',
      'relay_assignment_migrations',
      'relay_assignment_region_preferences',
      'relay_assignments'
    ]) {
      await admin().database.query(`DELETE FROM ${table} WHERE user_id LIKE '${USER_PREFIX}-%'`)
    }
  }

  async function heartbeatAll(): Promise<void> {
    for (const [index, config] of CELLS.entries()) {
      await admin().store.recordCellHeartbeat({
        cellId: config.id,
        cellUrl: config.url,
        cellIncarnation: `2222222${index}-2222-4222-8222-222222222222`,
        startedAt: NOW - 1_000,
        ready: true,
        observedRequests: 0,
        region: config.region,
        totalConnections: 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0,
        connectionHardCap: CAPPED.connectionHardCap,
        connectionUnobservedBound: CAPPED.connectionUnobservedBound
      })
    }
  }

  // Every host holds a live control lease on the source, then the source is
  // isolated for a roll: the state an Asia drain starts from.
  async function seed(hosts: Identity[]): Promise<void> {
    await deleteHostRows()
    await admin().database.query(
      `UPDATE relay_cells SET reserved_requests = 0 WHERE cell_id LIKE '${USER_PREFIX}-%'`
    )
    // Restoring the source to general also clears the previous run's roll stamp.
    await applySelector({
      [SOURCE.id]: 'general',
      ...Object.fromEntries(TARGETS.map((target) => [target.id, 'migration-only' as const]))
    })
    for (const identity of hosts) {
      const grant = await admin().store.assign(identity, 'asia-east2', 'asia-east2')
      expect(grant.cellId).toBe(SOURCE.id)
      await admin().store.activateControl(identity, {
        cellId: SOURCE.id,
        assignmentEpoch: grant.assignmentEpoch,
        generation: 1
      })
    }
    await applySelector(
      Object.fromEntries(TARGETS.map((target) => [target.id, 'general' as const]))
    )
    await applySelector({ [SOURCE.id]: 'migration-only' }, [SOURCE.id])
  }

  // Samples director backends so the report shows where director time goes: a
  // failed or slow placement leaves no hold sample behind.
  function sampleDirectorWaits(): { stop: () => Promise<{ waiting: number; active: number }> } {
    let running = true
    let samples = 0
    let waiting = 0
    let active = 0
    const loop = (async () => {
      while (running) {
        const rows = await observer.query(
          `SELECT wait_event_type FROM pg_stat_activity
           WHERE application_name = ? AND state = 'active'`,
          [DIRECTOR_APPLICATION]
        )
        samples += 1
        active += rows.length
        waiting += rows.filter((row) => row['wait_event_type'] === 'Lock').length
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    })()
    return {
      stop: async () => {
        running = false
        await loop
        return { waiting: mean(waiting, samples), active: mean(active, samples) }
      }
    }
  }

  async function run(roundTripMs: number, releaseRate: number): Promise<RunReport> {
    const releaseCount = Math.round((releaseRate * WINDOW_MS) / 1_000)
    const dialCount = Math.round((DIAL_RATE_PER_SECOND * WINDOW_MS) / 1_000)
    const releasing = Array.from({ length: releaseCount }, (_, index) => hostIdentity(index))
    const dialling = Array.from({ length: dialCount }, (_, index) =>
      hostIdentity(releaseCount + index)
    )
    await seed([...releasing, ...dialling])

    const releaseLatencies: number[] = []
    const releaseFailed: Tally = {}
    const releases = { attempted: 0, ok: 0, failed: releaseFailed }
    const admissionRejected: Tally = {}
    const dialFailed: Tally = {}
    const dials = {
      attempted: 0,
      placed: 0,
      placedInWindow: 0,
      admissionRejected,
      failed: dialFailed
    }
    const activationFailed: Tally = {}
    const activations = { ok: 0, failed: activationFailed }
    const activationWork: Promise<void>[] = []
    const stickyLanes = directors.map(() => new RelayPublicAssignmentAdmission(STICKY_LANE))
    for (const instance of directors) consumeRelayCellInventoryHold(instance.database)
    consumeRelayDatabasePoolPressure(asiaCell(SOURCE.id).database)
    delay.delayMs = roundTripMs
    delay.enabled = true
    const sampler = sampleDirectorWaits()
    const startedAt = performance.now()

    const releaseWork = paced(releaseRate, releaseCount, async (index) => {
      releases.attempted += 1
      const began = performance.now()
      try {
        const released = await asiaCell(SOURCE.id).store.releaseActivity(
          releasing[index]!,
          RELEASED_ACTIVITY
        )
        if (released) releases.ok += 1
        else count(releases.failed, 'lease_missing')
      } catch (error) {
        count(releases.failed, failureCode(error))
      }
      releaseLatencies.push(performance.now() - began)
    })
    // The reconnect path, round-robin over directors: sticky-lane admission,
    // the durable-pin check, then the assign the route calls, which re-places
    // off the isolated cell. The host then attaches to its new Asia cell.
    const dialWork = paced(DIAL_RATE_PER_SECOND, dialCount, async (index) => {
      const identity = dialling[index]!
      const director = directors[index % directors.length]!
      dials.attempted += 1
      let rejection = 'unknown'
      const lease = await stickyLanes[index % directors.length]!.acquire(
        identity.relayHostId,
        (reason) => {
          rejection = reason
        }
      )
      if (!lease) {
        count(dials.admissionRejected, rejection)
        return
      }
      try {
        if (!(await director.store.resolve(identity))) {
          count(dials.failed, 'unverified')
          return
        }
        const grant = await director.store.assign(identity, 'asia-east2', 'asia-east2')
        if (grant.cellId === SOURCE.id) {
          count(dials.failed, 'kept_on_source')
          return
        }
        dials.placed += 1
        if (performance.now() - startedAt <= WINDOW_MS) dials.placedInWindow += 1
        activationWork.push(
          asiaCell(grant.cellId)
            .store.activateControl(identity, {
              cellId: grant.cellId,
              assignmentEpoch: grant.assignmentEpoch,
              generation: 1
            })
            .then(
              () => {
                activations.ok += 1
              },
              (error: unknown) => count(activations.failed, failureCode(error))
            )
        )
      } catch (error) {
        count(dials.failed, failureCode(error))
      } finally {
        lease.release()
      }
    })
    await Promise.allSettled([...(await releaseWork), ...(await dialWork)])
    await Promise.allSettled(activationWork)
    const waits = await sampler.stop()
    delay.enabled = false

    const holds = directors.map((instance) => consumeRelayCellInventoryHold(instance.database))
    const report: RunReport = {
      roundTripMs,
      releaseRate,
      releases: {
        ...releases,
        p50Ms: percentile(releaseLatencies, 0.5),
        p95Ms: percentile(releaseLatencies, 0.95)
      },
      dials,
      activations,
      placementsPerSecond: Number(((dials.placedInWindow * 1_000) / WINDOW_MS).toFixed(1)),
      director: {
        lockUnavailable: holds.reduce((sum, hold) => sum + hold.cellInventoryLockUnavailable, 0),
        lockTimeouts: holds.reduce((sum, hold) => sum + hold.cellInventoryLockTimeouts, 0),
        holds: holds.reduce((sum, hold) => sum + hold.cellInventoryHolds, 0),
        holdMsMax: Math.round(Math.max(...holds.map((hold) => hold.cellInventoryHoldMsMax))),
        lockWaitingMean: waits.waiting,
        activeMean: waits.active
      },
      sourcePoolWaitersMax: consumeRelayDatabasePoolPressure(asiaCell(SOURCE.id).database)
        .databasePoolWaitersMax
    }
    reports.push(report)
    console.info(JSON.stringify({ event: 'drain_release_cell_row_contention', ...report }))
    return report
  }

  beforeAll(async () => {
    for (let index = 0; index < DIRECTOR_INSTANCES; index += 1) {
      const database = await openRelayDatabase({
        databaseUrl,
        dataDir: '',
        poolMax: DIRECTOR_POOL_MAX,
        applicationName: DIRECTOR_APPLICATION
      })
      directors.push({
        database,
        store: new RelayAssignmentStore(database, () => NOW, storeOptions)
      })
    }
    for (const config of CELLS) {
      const database = openDelayedPostgresDatabase(databaseUrl!, delay, CELL_POOL_MAX)
      asiaCells.set(config.id, {
        database,
        store: new RelayAssignmentStore(database, () => NOW, storeOptions)
      })
    }
    observer = await openRelayDatabase({ databaseUrl, dataDir: '', poolMax: 1 })
    await deleteHostRows()
    await admin().store.reconcileCells(CELLS, false)
    await resetSelectorBoundary()
    await heartbeatAll()
  })

  afterAll(async () => {
    delay.enabled = false
    if (reports.length > 0) console.table(reports.map(flattenReport))
    if (directors.length > 0) {
      await deleteHostRows()
      // Cells before the selector rebuild, or its membership names missing rows.
      for (const config of CELLS) {
        for (const table of [
          'relay_cell_connection_snapshots',
          'relay_cell_connection_runtime',
          'relay_cell_connection_limits',
          'relay_cell_runtime',
          'relay_cell_admission',
          'relay_cell_regions',
          'relay_cells'
        ]) {
          await admin().database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [config.id])
        }
      }
      await resetSelectorBoundary()
    }
    for (const instance of [...directors, ...asiaCells.values()]) await instance.database.close()
    await observer?.close()
  })

  it('keeps placing during a paced drain when the cells are next to the database', async () => {
    for (const rate of [6, 18]) {
      const report = await run(LOCAL_ROUND_TRIP_MS, rate)
      expect(report.releases.failed).toEqual({})
      expect(report.dials.failed).toEqual({})
      expect(report.dials.admissionRejected).toEqual({})
      expect(report.placementsPerSecond).toBeGreaterThanOrEqual(0.9 * DIAL_RATE_PER_SECOND)
    }
  }, 120_000)

  it('starves director placement once the draining cell is an Asia round trip away', async () => {
    const paced6 = await run(ASIA_ROUND_TRIP_MS, 6)
    const herd18 = await run(ASIA_ROUND_TRIP_MS, 18)
    // Measured 9.2-9.5/s and 4.5-5.3/s against 20/s at local latency.
    expect(paced6.placementsPerSecond).toBeLessThan(0.75 * DIAL_RATE_PER_SECOND)
    expect(herd18.placementsPerSecond).toBeLessThan(0.5 * DIAL_RATE_PER_SECOND)
    expect(herd18.placementsPerSecond).toBeLessThan(paced6.placementsPerSecond)
    expect(total(herd18.dials.admissionRejected)).toBeGreaterThan(0)
    // Every active director backend is blocked on a lock. The 500ms bound never
    // fires: lock_timeout is per acquisition, and each hold ahead is ~1 RTT.
    expect(herd18.director.activeMean).toBeGreaterThan(1)
    expect(herd18.director.lockWaitingMean).toBeGreaterThanOrEqual(0.9 * herd18.director.activeMean)
    // Releases on one row serialise at ~1/RTT (~5.8/s); the excess sheds.
    expect(herd18.releases.ok).toBeLessThan(0.6 * herd18.releases.attempted)
    expect(total(herd18.releases.failed)).toBeGreaterThan(0)
  }, 180_000)
})

function flattenReport(report: RunReport): Record<string, string | number> {
  const failed = (tally: Tally): string =>
    Object.entries(tally)
      .map(([key, value]) => `${key}:${value}`)
      .join(' ') || '-'
  return {
    rttMs: report.roundTripMs,
    releasesPerSec: report.releaseRate,
    releasesOk: report.releases.ok,
    releasesFailed: failed(report.releases.failed),
    releaseP95Ms: report.releases.p95Ms,
    dialsPlaced: report.dials.placed,
    placementsPerSec: report.placementsPerSecond,
    dialsFailed: failed(report.dials.failed),
    stickyRejected: failed(report.dials.admissionRejected),
    lockTimeouts: report.director.lockTimeouts,
    lockUnavailable: report.director.lockUnavailable,
    lockWaiting: `${report.director.lockWaitingMean}/${report.director.activeMean}`,
    activationsFailed: failed(report.activations.failed)
  }
}

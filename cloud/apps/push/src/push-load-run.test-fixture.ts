import type { PushNotification } from '@orca-cloud/push-contract'
import { DurablePushStore, type QueuedPushDelivery } from './durable-push-store.js'
import { DurablePushWorker } from './durable-push-worker.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { FcmClient } from './fcm-client.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import { PushHostSessionStore } from './host-session-store.js'
import { reserveRequestConnection } from './push-background-database.js'
import type { PushDatabase } from './push-database.js'
import { PushDispatcher } from './push-dispatcher.js'
import { SlotLedger, withRoundTripLatency } from './push-load-database-instrumentation.test-fixture.js'
import { startLoadBackground, type PruneScheduler } from './push-load-prune-schedulers.test-fixture.js'
import {
  createLoadDatabase,
  hostFingerprint,
  LOAD_EPOCH,
  registrationId,
  seedLoadDatabase,
  seedPendingBacklog,
  type LoadPopulation,
  type PendingSeed,
  type RetentionSeed
} from './push-load-seed.test-fixture.js'

export type LoadConfig = {
  label: string
  poolMax: number
  scheduler: PruneScheduler
  durationMs: number
  deliveriesPerSecond: number
  rttMs: number
  pruneFullBatchMs: number
  providerLatencyMs: number
  population: LoadPopulation
  retention: RetentionSeed
  pending: PendingSeed
}

export type ItemOutcome = {
  seq: number
  seeded: boolean
  enqueuedAt: number
  expiresAt: number
  claimedAt?: number
  // Worker wall time from asking for a claim to its finish returning: the drain's per-item cost.
  cycleMs?: number
  deliveredAt?: number
  expiredAtDispatchAt?: number
  retries: number
}

export type LoadRun = {
  config: LoadConfig
  startedAt: number
  stoppedAt: number
  items: Map<number, ItemOutcome>
  ledger: SlotLedger
  acceptFailures: number
  acceptLatenciesMs: number[]
  eligibleAtStart: Record<string, number>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const notificationFor = (seq: number): PushNotification => ({
  notificationId: `load-${seq}`,
  notificationEpoch: LOAD_EPOCH,
  notificationSeq: seq,
  source: 'agent-task-complete',
  agentState: 'finished',
  title: 'Done',
  body: '',
  kind: 'alert'
})

// Records each claim and each finish that did not follow a provider send.
class OutcomeRecordingStore extends DurablePushStore {
  constructor(
    database: PushDatabase,
    background: PushDatabase,
    private readonly items: Map<number, ItemOutcome>
  ) {
    super(database, Date.now, background)
  }

  override async claim(): Promise<QueuedPushDelivery | null> {
    const requestedAt = Date.now()
    const queued = await super.claim()
    const item = queued ? this.items.get(queued.notification.notificationSeq) : undefined
    if (item) {
      item.claimedAt = Date.now()
      this.claimRequestedAt.set(item.seq, requestedAt)
    }
    return queued
  }

  override async finish(delivery: QueuedPushDelivery, retryAfterMs?: number): Promise<void> {
    const item = this.items.get(delivery.notification.notificationSeq)
    if (item && retryAfterMs !== undefined) item.retries++
    else if (item && item.deliveredAt === undefined) item.expiredAtDispatchAt = Date.now()
    await super.finish(delivery, retryAfterMs)
    const requestedAt = item ? this.claimRequestedAt.get(item.seq) : undefined
    if (item && requestedAt !== undefined) item.cycleMs = Date.now() - requestedAt
  }
  private readonly claimRequestedAt = new Map<number, number>()
}

async function countEligible(
  database: { query: (sql: string, params?: unknown[]) => Promise<{ total?: unknown }[]> },
  now: number
): Promise<Record<string, number>> {
  const cutoff = now - 24 * 60 * 60_000
  const counts: Record<string, number> = {}
  for (const table of ['push_events', 'push_event_recipients', 'push_dismissed_events']) {
    const [row] = await database.query(
      `SELECT COUNT(*) AS total FROM ${table} WHERE created_at < ?`,
      [cutoff]
    )
    counts[table] = Number(row?.total ?? 0)
  }
  return counts
}

export async function runLoad(adminUrl: string, config: LoadConfig): Promise<LoadRun> {
  const { database: raw, url, drop } = await createLoadDatabase(adminUrl, config.poolMax)
  try {
    await seedLoadDatabase(url, config.population, config.retention, Date.now())
    const items = new Map<number, ItemOutcome>()
    const seeded = await seedPendingBacklog(url, config.population, config.pending, Date.now())
    for (const item of seeded) items.set(item.seq, { ...item, seeded: true, retries: 0 })
    const database = withRoundTripLatency(raw, config.rttMs, config.pruneFullBatchMs)
    const ledger = new SlotLedger()
    const background = ledger.requesting(
      reserveRequestConnection(ledger.admitted(database), config.poolMax)
    )
    const store = new OutcomeRecordingStore(database, background, items)
    const fcm = new FcmClient({
      projectId: 'load',
      accessToken: async () => 'token',
      transport: async (request) => {
        await sleep(config.providerLatencyMs)
        const body = JSON.parse(request.body) as { message: { data: { notificationSeq: string } } }
        const item = items.get(Number(body.message.data.notificationSeq))
        if (item) item.deliveredAt = Date.now()
        return { status: 200, body: '{"name":"projects/load/messages/1"}' }
      }
    })
    const dispatcher = new PushDispatcher({ devices: new PushDeviceRegistryStore(database), fcm })
    const worker = new DurablePushWorker(store, dispatcher)
    const eligibleAtStart = await countEligible(raw, Date.now())
    const startedAt = Date.now()
    const stop = startLoadBackground(config.scheduler, {
      challenges: new PushHostChallengeStore(database, 'https://push.load.invalid'),
      sessions: new PushHostSessionStore(database),
      deliveryStore: store,
      worker
    })
    let acceptFailures = 0
    const acceptLatenciesMs: number[] = []
    const accepts: Promise<void>[] = []
    const { hosts, devicesPerHost } = config.population
    const tickMs = 100
    let seq = 0
    for (let tick = 0; Date.now() - startedAt < config.durationMs; tick++) {
      const due = Math.floor(((tick + 1) * tickMs * config.deliveriesPerSecond) / 1000)
      for (; seq < due; seq++) {
        const current = seq
        const host = current % hosts
        const enqueuedAt = Date.now()
        items.set(current, {
          seq: current,
          seeded: false,
          enqueuedAt,
          expiresAt: enqueuedAt + 300_000,
          retries: 0
        })
        accepts.push(
          store
            .accept(
              hostFingerprint(host),
              registrationId(host, Math.floor(current / hosts) % devicesPerHost),
              notificationFor(current)
            )
            .then((result) => {
              acceptLatenciesMs.push(Date.now() - enqueuedAt)
              if (result !== 'queued') acceptFailures++
            })
            .catch(() => {
              acceptFailures++
            })
        )
      }
      const nextTickAt = startedAt + (tick + 1) * tickMs
      await sleep(Math.max(0, nextTickAt - Date.now()))
    }
    const stoppedAt = Date.now()
    await stop()
    await Promise.all(accepts)
    return {
      config,
      startedAt,
      stoppedAt,
      items,
      ledger,
      acceptFailures,
      acceptLatenciesMs,
      eligibleAtStart
    }
  } finally {
    await drop()
  }
}

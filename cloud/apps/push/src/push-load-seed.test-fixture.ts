import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { openPushDatabase, type PushDatabase } from './push-database.js'

const DAY_MS = 24 * 60 * 60_000
export const LOAD_EPOCH = 'load-epoch'
// Seeded backlog seqs sit far above any inflow seq so both share one outcome ledger.
export const SEEDED_SEQ_BASE = 1_000_000_000

export type LoadPopulation = { hosts: number; devicesPerHost: number }
export type RetentionSeed = {
  // Rows per second that were written a day ago and so turn prune-eligible each second now.
  eventsPerSecond: number
  dismissalsPerSecond: number
  // Rows already past retention at the start, as a one-interval-late sweep would find them.
  eligibleBacklogMs: number
}
export type PendingSeed = { backlogMs: number; perSecond: number }

export const registrationId = (host: number, device: number) => `reg-${host}-${device}`
export const hostFingerprint = (host: number) => `host-${String(host).padStart(6, '0')}`

export async function createLoadDatabase(
  adminUrl: string,
  poolMax: number
): Promise<{ database: PushDatabase; url: string; drop: () => Promise<void> }> {
  if (!process.env.CI && !/^5544[0-9]$/.test(new URL(adminUrl).port))
    throw new Error('isolated_postgres_port_required')
  const name = `push_load_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  const database = await openPushDatabase({ databaseUrl: url.toString(), dataDir: '', poolMax })
  return {
    database,
    url: url.toString(),
    drop: async () => {
      try {
        await database.close()
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
        await admin.end()
      }
    }
  }
}

// Writes the steady retention window straight through SQL: the store has no bulk path and the
// seed must not share the connection budget under test.
export async function seedLoadDatabase(
  url: string,
  population: LoadPopulation,
  seed: RetentionSeed,
  now: number
): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(
      `INSERT INTO push_devices(registration_id, host_fingerprint, device_id, platform, token, apns_environment, dead_at, created_at, updated_at)
      SELECT 'reg-' || h || '-' || d, 'host-' || lpad(h::text, 6, '0'), 'device-' || d, 'android', 'token-' || h || '-' || d, NULL, NULL, $1, $1
      FROM generate_series(0, $2 - 1) h, generate_series(0, $3 - 1) d`,
      [now - DAY_MS, population.hosts, population.devicesPerHost]
    )
    const retentionStart = now - DAY_MS - seed.eligibleBacklogMs
    const window = DAY_MS + seed.eligibleBacklogMs
    const events = Math.floor((window / 1000) * seed.eventsPerSecond)
    await client.query(
      `INSERT INTO push_events(event_id, host_fingerprint, kind, fingerprint, created_at, expires_at)
      SELECT encode(sha256(('seed-event-' || i)::bytea), 'hex'), 'host-' || lpad((i % $3)::text, 6, '0'), 'alert',
        encode(sha256(('seed-content-' || i)::bytea), 'hex'), $1 + (i * $4::float8)::bigint, $1 + (i * $4::float8)::bigint + 300000
      FROM generate_series(0, $2 - 1) i`,
      [retentionStart, events, population.hosts, 1000 / seed.eventsPerSecond]
    )
    await client.query(
      `INSERT INTO push_event_recipients(event_id, registration_id, created_at)
      SELECT encode(sha256(('seed-event-' || i)::bytea), 'hex'), 'reg-' || (i % $3) || '-' || ((i / $3) % $5), $1 + (i * $4::float8)::bigint
      FROM generate_series(0, $2 - 1) i`,
      [retentionStart, events, population.hosts, 1000 / seed.eventsPerSecond, population.devicesPerHost]
    )
    const dismissals = Math.floor((window / 1000) * seed.dismissalsPerSecond)
    await client.query(
      `INSERT INTO push_dismissed_events(host_fingerprint, notification_epoch, notification_id, notification_seq, created_at)
      SELECT 'host-' || lpad((i % $3)::text, 6, '0'), 'seed-epoch', 'seed-dismissed-' || i, i, $1 + (i * $4::float8)::bigint
      FROM generate_series(0, $2 - 1) i`,
      [retentionStart, dismissals, population.hosts, 1000 / seed.dismissalsPerSecond]
    )
    await client.query('VACUUM ANALYZE')
  } finally {
    await client.end()
  }
}

// Seeded separately, right before the run starts, so seeding time does not age the backlog.
export async function seedPendingBacklog(
  url: string,
  population: LoadPopulation,
  seed: PendingSeed,
  now: number
): Promise<{ seq: number; enqueuedAt: number; expiresAt: number }[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const pendingCount = Math.floor((seed.backlogMs / 1000) * seed.perSecond)
    const seededPending = Array.from({ length: pendingCount }, (_, i) => {
      const enqueuedAt = now - seed.backlogMs + Math.floor((i * 1000) / seed.perSecond)
      return { seq: SEEDED_SEQ_BASE + i, enqueuedAt, expiresAt: enqueuedAt + 300_000 }
    })
    await client.query(
      `INSERT INTO push_delivery_batches(batch_id, host_fingerprint, registration_id, kind, payload_json, state, due_at, expires_at, lease_until, attempts, created_at)
      SELECT gen_random_uuid()::text, 'host-' || lpad((i % $4)::text, 6, '0'), 'reg-' || (i % $4) || '-' || ((i / $4) % $5), 'alert',
        json_build_object('notificationId', 'seed-' || i, 'notificationEpoch', $6::text, 'notificationSeq', $7::bigint + i,
          'source', 'agent-task-complete', 'agentState', 'finished', 'title', 'Done', 'body', '', 'kind', 'alert')::text,
        'pending', t, t + 300000, 0, 0, t
      FROM (SELECT i, ($1 + (i * $3::float8))::bigint AS t FROM generate_series(0, $2 - 1) i) s`,
      [
        now - seed.backlogMs,
        pendingCount,
        1000 / seed.perSecond,
        population.hosts,
        population.devicesPerHost,
        LOAD_EPOCH,
        SEEDED_SEQ_BASE
      ]
    )
    await client.query('ANALYZE push_delivery_batches')
    return seededPending
  } finally {
    await client.end()
  }
}

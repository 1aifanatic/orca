import { PRUNE_BATCH_ROWS } from './durable-push-store.js'
import type { PushDatabase } from './push-database.js'

const sleep = (ms: number) =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

const PRUNE_DELETE = /^DELETE FROM \w+ WHERE \(/

// Adds one network round trip per statement, BEGIN and COMMIT; transactional sleeps hold the connection.
// pruneFullBatchMs stands in for a retention DELETE that is IO-bound on a cold production cache:
// the slot is held that long for a full batch, and proportionally less for a short one.
export function withRoundTripLatency(
  database: PushDatabase,
  rttMs: number,
  pruneFullBatchMs = 0
): PushDatabase {
  const wrapTransaction = (tx: PushDatabase): PushDatabase => ({
    dialect: tx.dialect,
    query: async (sql, params) => {
      await sleep(rttMs)
      return tx.query(sql, params)
    },
    transaction: (operation) => operation(wrapTransaction(tx)),
    lockQuotaScope: async (key) => {
      await sleep(rttMs)
      return tx.lockQuotaScope(key)
    },
    tryLockScope: async (key) => {
      await sleep(rttMs)
      return tx.tryLockScope(key)
    },
    tryLockSharedScope: async (key) => {
      await sleep(rttMs)
      return tx.tryLockSharedScope(key)
    },
    close: () => tx.close()
  })
  return {
    dialect: database.dialect,
    query: async (sql, params) => {
      await sleep(rttMs)
      const rows = await database.query(sql, params)
      if (pruneFullBatchMs > 0 && PRUNE_DELETE.test(sql))
        await sleep((pruneFullBatchMs * Number(rows[0]?.changes ?? 0)) / PRUNE_BATCH_ROWS)
      return rows
    },
    transaction: (operation) =>
      database.transaction(async (tx) => {
        await sleep(rttMs)
        const result = await operation(wrapTransaction(tx))
        await sleep(rttMs)
        return result
      }),
    lockQuotaScope: (key) => database.lockQuotaScope(key),
    tryLockScope: (key) => database.tryLockScope(key),
    tryLockSharedScope: (key) => database.tryLockSharedScope(key),
    close: () => database.close()
  }
}

export type SlotKind = 'claim' | 'finish' | 'prune' | 'other'
export type SlotSample = {
  kind: SlotKind
  requestedAt: number
  admittedAt: number
  endedAt: number
  table?: string
  changes?: number
}

function classify(sql: string): { kind: SlotKind; table?: string } {
  const prune = /^DELETE FROM (\w+) WHERE \(/.exec(sql)
  if (prune) return { kind: 'prune', table: prune[1] }
  if (/^(DELETE FROM|UPDATE) push_delivery_batches/.test(sql)) return { kind: 'finish' }
  return { kind: 'other' }
}

// Records, per background call, when it asked for the admission slot, when it got it, and when it
// released it. The gate admits FIFO, so the n-th inner call belongs to the n-th outer request.
export class SlotLedger {
  readonly samples: SlotSample[] = []
  private readonly requested: number[] = []

  // Goes between reserveRequestConnection and the database: sees only admitted work.
  admitted(database: PushDatabase): PushDatabase {
    const run = async <T>(
      kind: { kind: SlotKind; table?: string },
      operation: () => Promise<T>
    ): Promise<T> => {
      const requestedAt = this.requested.shift() ?? Date.now()
      const admittedAt = Date.now()
      const sample: SlotSample = { ...kind, requestedAt, admittedAt, endedAt: admittedAt }
      try {
        const result = await operation()
        if (kind.kind === 'prune' && Array.isArray(result))
          sample.changes = Number((result[0] as { changes?: unknown } | undefined)?.changes ?? 0)
        return result
      } finally {
        sample.endedAt = Date.now()
        this.samples.push(sample)
      }
    }
    return {
      dialect: database.dialect,
      query: (sql, params) => run(classify(sql), () => database.query(sql, params)),
      transaction: (operation) => run({ kind: 'claim' }, () => database.transaction(operation)),
      lockQuotaScope: (key) => database.lockQuotaScope(key),
      tryLockScope: (key) => database.tryLockScope(key),
      tryLockSharedScope: (key) => database.tryLockSharedScope(key),
      close: () => database.close()
    }
  }

  // Wraps the gated database to stamp the moment each call joined the admission queue.
  requesting(gated: PushDatabase): PushDatabase {
    const stamp = () => this.requested.push(Date.now())
    return {
      dialect: gated.dialect,
      query: (sql, params) => {
        stamp()
        return gated.query(sql, params)
      },
      transaction: (operation) => {
        stamp()
        return gated.transaction(operation)
      },
      lockQuotaScope: (key) => gated.lockQuotaScope(key),
      tryLockScope: (key) => gated.tryLockScope(key),
      tryLockSharedScope: (key) => gated.tryLockSharedScope(key),
      close: () => gated.close()
    }
  }
}

import { createServer as createNetServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { RelayConfig } from './config.js'
import { PostgresDatabase } from './database.js'
import { createRelayServer, HOST_HELLO_POOL_WAITING_LIMIT } from './relay-server.js'

async function unusedPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

// pg-pool's shape with every acquire stuck, so queued work only accumulates.
function stalledPool() {
  const pool = {
    options: { max: 2, connectionTimeoutMillis: 0 },
    totalCount: 2,
    idleCount: 0,
    waitingCount: 0,
    connect: () => {
      pool.waitingCount++
      return new Promise<never>(() => {})
    },
    end: async () => undefined
  }
  return pool
}

function cellConfig(port: number): RelayConfig {
  const relayUrl = `http://127.0.0.1:${port}`
  return {
    port,
    publicUrl: relayUrl,
    cellUrl: relayUrl,
    authIssuer: relayUrl,
    authAudience: 'orca-relay',
    jwksUrl: relayUrl,
    assignmentSigningKey: new Uint8Array(32),
    role: 'cell',
    cellId: 'production-gce-c3',
    cells: [{ id: 'production-gce-c3', url: relayUrl, capacityRequests: 4_000 }],
    adminAudience: `${relayUrl}/admin`,
    deployServiceAccount: 'deploy@example.com',
    runtimeServiceAccount: 'runtime@example.com',
    connectionHardCap: 600,
    connectionUnobservedBound: 60,
    adminJwksUrl: `${relayUrl}/admin-jwks`,
    databasePoolMax: 2,
    publicAssignmentsEnabled: true,
    publicAssignmentConcurrency: 1,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './test-data'
  }
}

async function controlUpgradeResponse(
  url: string
): Promise<{ status: number; retryAfter: string | undefined }> {
  const socket = new WebSocket(`${url.replace('http:', 'ws:')}/v1/host/control`, {
    perMessageDeflate: false
  })
  return await new Promise((resolve, reject) => {
    socket.once('unexpected-response', (request, response) => {
      resolve({ status: response.statusCode ?? 0, retryAfter: response.headers['retry-after'] })
      request.destroy()
    })
    socket.once('open', () => reject(new Error('control upgrade was accepted')))
  })
}

describe('host hello shedding under database pool pressure', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function startCell(waiters: number): Promise<string> {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const database = new PostgresDatabase(stalledPool() as never)
    // Every query either stalls inside the pool or queues behind those that did.
    for (let index = 0; index < waiters; index++) void database.query('SELECT 1').catch(() => {})
    const port = await unusedPort()
    const relay = createRelayServer(cellConfig(port), database)
    relay.server.listen(port, '127.0.0.1')
    await new Promise<void>((resolve) => relay.server.once('listening', resolve))
    cleanup.push(() => new Promise<void>((resolve) => relay.server.close(() => resolve())))
    return `http://127.0.0.1:${port}`
  }

  it('refuses a host control upgrade with a retryable 503 once the pool queue is full', async () => {
    const url = await startCell(HOST_HELLO_POOL_WAITING_LIMIT)

    expect(await controlUpgradeResponse(url)).toEqual({ status: 503, retryAfter: '2' })
    // Shipped desktops dial with no unexpected-response listener, so the refusal
    // reaches them as the ordinary connect error their retry backoff handles.
    const desktop = new WebSocket(`${url.replace('http:', 'ws:')}/v1/host/control`)
    const error = await new Promise<Error>((resolve) => desktop.once('error', resolve))
    expect(error.message).toBe('Unexpected server response: 503')
  })

  it('admits a host control upgrade while the pool queue is below the limit', async () => {
    const url = await startCell(HOST_HELLO_POOL_WAITING_LIMIT - 1)

    // Past the shed check, the missing bearer is what refuses it.
    expect(await controlUpgradeResponse(url)).toEqual({ status: 401, retryAfter: undefined })
  })
})

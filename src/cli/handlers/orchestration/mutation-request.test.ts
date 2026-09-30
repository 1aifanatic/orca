import { createServer, type Server } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'

const RETRY_MS = 120_000
const WORKER_DONE = {
  from: 'term_worker',
  subject: 'done',
  type: 'worker_done',
  payload: '{"taskId":"task_1","dispatchId":"ctx_1","outcome":"succeeded"}'
}

const RuntimeRequest = z.object({
  id: z.string(),
  method: z.string(),
  orchestrationRequestId: z.string().optional()
})

const servers = new Set<Server>()

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))))
  servers.clear()
})

type CallOptions = { orchestrationRequestId?: string }

function fakeClient(respond: (attempt: number, options?: CallOptions) => unknown): {
  client: RuntimeClient
  requestIds: (string | undefined)[]
} {
  const requestIds: (string | undefined)[] = []
  const call = vi.fn(async (_method: string, _params: unknown, options?: CallOptions) => {
    requestIds.push(options?.orchestrationRequestId)
    return respond(requestIds.length, options)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callOrchestrationMutation only uses client.call.
  return { client: { call } as unknown as RuntimeClient, requestIds }
}

function unavailable(options?: CallOptions): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Could not connect to the running Orca app.',
    {
      orchestrationRequestId: options?.orchestrationRequestId,
      originalCommand: ['orca', 'orchestration', 'send', '--type', 'worker_done']
    }
  )
}

describe('callOrchestrationMutation runtime_unavailable retry', () => {
  it('retries with one request id until the runtime answers', async () => {
    vi.useFakeTimers()
    const { client, requestIds } = fakeClient((attempt, options) => {
      if (attempt < 3) {
        throw unavailable(options)
      }
      return { ok: true, result: 'sent' }
    })
    const call = callOrchestrationMutation(client, new Map(), 'orchestration.send', WORKER_DONE, {
      unavailableRetryMs: RETRY_MS
    })
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(call).resolves.toEqual({ ok: true, result: 'sent' })
    expect(requestIds).toHaveLength(3)
    expect(new Set(requestIds).size).toBe(1)
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps an explicit --retry-request id across retries', async () => {
    vi.useFakeTimers()
    const retryRequest = '11111111-2222-4333-8444-555555555555'
    const { client, requestIds } = fakeClient((attempt, options) => {
      if (attempt === 1) {
        throw unavailable(options)
      }
      return { ok: true, result: 'sent' }
    })
    const call = callOrchestrationMutation(
      client,
      new Map([['retry-request', retryRequest]]),
      'orchestration.send',
      WORKER_DONE,
      { unavailableRetryMs: RETRY_MS }
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await call
    expect(requestIds).toEqual([retryRequest, retryRequest])
  })

  it('does not retry an error other than runtime_unavailable', async () => {
    const { client, requestIds } = fakeClient(() => {
      throw new RuntimeClientError('runtime_timeout', 'Timed out.')
    })
    await expect(
      callOrchestrationMutation(client, new Map(), 'orchestration.send', WORKER_DONE, {
        unavailableRetryMs: RETRY_MS
      })
    ).rejects.toMatchObject({ code: 'runtime_timeout' })
    expect(requestIds).toHaveLength(1)
  })

  it('does not retry mutations that did not opt in', async () => {
    const { client, requestIds } = fakeClient((_attempt, options) => {
      throw unavailable(options)
    })
    await expect(
      callOrchestrationMutation(client, new Map(), 'orchestration.send', {
        ...WORKER_DONE,
        type: 'status'
      })
    ).rejects.toMatchObject({ code: 'runtime_unavailable' })
    expect(requestIds).toEqual([undefined])
  })

  it('gives up after about two minutes and prints the recovery command with the same id', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    const { client, requestIds } = fakeClient((_attempt, options) => {
      throw unavailable(options)
    })
    const call = callOrchestrationMutation(client, new Map(), 'orchestration.send', WORKER_DONE, {
      unavailableRetryMs: RETRY_MS
    })
    const settled = call.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(RETRY_MS + 30_000)
    const error = await settled
    expect(Date.now() - startedAt).toBeLessThanOrEqual(RETRY_MS + 30_000)
    expect(requestIds.length).toBeGreaterThan(5)
    expect(new Set(requestIds).size).toBe(1)
    expect(error).toMatchObject({
      code: 'runtime_unavailable',
      data: {
        recovery: {
          retryCommand: [
            'orca',
            'orchestration',
            'send',
            '--type',
            'worker_done',
            '--retry-request',
            requestIds[0]
          ]
        }
      }
    })
  })

  it('reaches a runtime that comes back after the first attempt found it down', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-worker-done-retry-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const sendRequestIds: string[] = []
    const server = createServer((socket) => {
      socket.setEncoding('utf8')
      socket.once('data', (line: string) => {
        const request = RuntimeRequest.parse(JSON.parse(line.trim()))
        if (request.method === 'orchestration.send') {
          sendRequestIds.push(String(request.orchestrationRequestId))
          if (sendRequestIds.length === 1) {
            // A runtime that drops the connection mid-request leaves the outcome unknown.
            socket.destroy()
            return
          }
        }
        socket.end(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result:
              request.method === 'status.get'
                ? { capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] }
                : { message: { id: 'msg_1' } },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    const client = new RuntimeClient(userDataPath, 5_000, null, null, 'orca')
    const call = callOrchestrationMutation(client, new Map(), 'orchestration.send', WORKER_DONE, {
      unavailableRetryMs: RETRY_MS
    })
    // The runtime is down for the first attempt: no metadata, so even the contract probe fails.
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: 1,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: 1
      })
    )
    await expect(call).resolves.toMatchObject({ result: { message: { id: 'msg_1' } } })
    expect(sendRequestIds).toHaveLength(2)
    expect(sendRequestIds[1]).toBe(sendRequestIds[0])
  }, 15_000)
})

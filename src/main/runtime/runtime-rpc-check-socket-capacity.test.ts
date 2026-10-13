import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession, waitFor } from './runtime-rpc-test-harness'

it('preserves fresh client connections with a configured pool of 64 and 40 check sockets', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-check-socket-capacity-'))
  vi.stubEnv('ORCA_RPC_LONG_POLL_CAP', '64')
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, methods: [] })
  const sessions: ReturnType<typeof openFramedSession>[] = []
  const socketErrors: unknown[] = []
  let abortedChecks = 0
  // Exercise transport admission independently of worker launch and coordinator Run setup.
  vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request, options) => {
    if (classifyRuntimeLongPoll(request) === 'check') {
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener(
          'abort',
          () => {
            abortedChecks++
            resolve()
          },
          { once: true }
        )
      })
    }
    return {
      id: request.id,
      ok: true,
      result: { admitted: request.method },
      _meta: { runtimeId: runtime.getRuntimeId() }
    }
  })

  try {
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    const endpoint = metadata?.transports[0]?.endpoint
    if (!metadata || !endpoint) {
      throw new Error('Missing runtime socket metadata')
    }
    const request = (id: string, method: string, params?: unknown) => {
      const session = openFramedSession(endpoint, {
        id,
        authToken: metadata.authToken,
        method,
        params
      })
      sessions.push(session)
      void session.done.catch((error: unknown) => socketErrors.push(error))
      return session
    }
    const checks = Array.from({ length: 40 }, (_, index) =>
      request(`check-${index}`, 'orchestration.check', { wait: true })
    )
    await waitFor(
      () =>
        socketErrors.length > 0 ||
        (server['activeCheckLongPolls'] === 32 &&
          checks.filter((check) => check.frames.some((frame) => frame.ok === false)).length === 8)
    )
    expect(socketErrors).toEqual([])
    for (const check of checks) {
      for (const frame of check.frames.filter((frame) => frame.ok !== undefined)) {
        expect(frame).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
      }
    }

    const fresh = [
      request('startup', 'orchestration.workerStart'),
      request('settings', 'settings.update', { compactWorktreeCards: true }),
      request('nonblocking', 'orchestration.check', { wait: false })
    ]
    await Promise.all(fresh.map((session) => session.done))
    for (const session of fresh) {
      expect(session.frames).toEqual([expect.objectContaining({ ok: true })])
    }
    expect(server['activeLongPolls']).toBe(32)
  } finally {
    for (const session of sessions) {
      session.socket.destroy()
    }
    await Promise.allSettled(sessions.map((session) => session.done))
    await server.stop()
    await waitFor(() => server['activeLongPolls'] === 0)
    vi.unstubAllEnvs()
    rmSync(userDataPath, { recursive: true, force: true })
  }
  expect(abortedChecks).toBe(32)
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { readRuntimeMetadata } from './runtime-metadata'
import { openFramedSession, sendRequest, waitFor } from './runtime-rpc-test-harness'

const mutations = [
  { method: 'terminal.send', params: { agentPrompt: true } },
  { method: 'agent.launch', params: { prompt: { text: 'continue' } } },
  { method: 'agent.launchReplay', params: { prompt: { text: 'continue' } } },
  { method: 'orchestration.workerStart', params: {} },
  {
    method: 'orchestration.dispatch',
    params: { inject: true, to: 'orca_session_id:chat' }
  }
]

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('slow mutations under passive observation load', () => {
  it.each(mutations)(
    'dispatches $method through the local transport at the wait cap',
    async (action) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mutation-admission-'))
      const runtime = new OrcaRuntimeService()
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, longPollCap: 1 })
      const observer = deferred()
      const mutation = deferred()
      const dispatched: string[] = []
      vi.spyOn(server['dispatcher'], 'dispatch').mockImplementation(async (request, context) => {
        dispatched.push(request.id)
        expect(context?.signal).toBeDefined()
        await (request.method === 'terminal.wait' ? observer.promise : mutation.promise)
        return {
          id: request.id,
          ok: true,
          result: { accepted: true },
          _meta: { runtimeId: runtime.getRuntimeId() }
        }
      })
      await server.start()
      try {
        const metadata = readRuntimeMetadata(userDataPath)
        if (!metadata?.transports[0]) {
          throw new Error('Missing test transport')
        }
        const endpoint = metadata.transports[0].endpoint
        const waiting = openFramedSession(endpoint, {
          id: 'observer',
          authToken: metadata.authToken,
          method: 'terminal.wait'
        })
        await waitFor(() => server['activeLongPolls'] === 1)

        const acting = sendRequest(endpoint, {
          id: 'action',
          authToken: metadata.authToken,
          ...action
        })
        await waitFor(() => dispatched.includes('action'))
        expect(server['activeLongPolls']).toBe(1)

        const overflow = await sendRequest(endpoint, {
          id: 'overflow',
          authToken: metadata.authToken,
          method: 'terminal.wait'
        })
        expect(overflow).toMatchObject({ ok: false, error: { code: 'runtime_busy' } })
        mutation.resolve()
        expect(await acting).toMatchObject({ id: 'action', ok: true })
        expect(server['activeLongPolls']).toBe(1)
        observer.resolve()
        await waiting.done
        await waitFor(() => server['activeLongPolls'] === 0)
      } finally {
        mutation.resolve()
        observer.resolve()
        await server.stop()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )

  it.each(mutations)(
    'dispatches $method over a paired connection at the wait cap',
    async (action) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mutation-admission-'))
      const runtime = new OrcaRuntimeService()
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, longPollCap: 1 })
      server['deviceRegistry'] = new DeviceRegistry(userDataPath)
      const device = server['deviceRegistry'].addDevice('test-desktop', 'runtime')
      const observer = deferred()
      const mutation = deferred()
      const dispatched: string[] = []
      const replies: string[] = []
      vi.spyOn(server['dispatcher'], 'dispatchStreaming').mockImplementation(
        async (request, reply) => {
          dispatched.push(request.id)
          await (request.method === 'terminal.wait' ? observer.promise : mutation.promise)
          reply(JSON.stringify({ id: request.id, ok: true }))
        }
      )
      const dispatch = (id: string, method: string, params?: unknown): Promise<void> =>
        server['handleWebSocketMessage'](
          JSON.stringify({ id, method, params, deviceToken: device.token }),
          (reply) => replies.push(reply),
          () => {}
        )
      try {
        const waiting = dispatch('observer', 'terminal.wait')
        await waitFor(() => server['activeLongPolls'] === 1)
        const acting = dispatch('action', action.method, action.params)
        await waitFor(() => dispatched.includes('action'))
        expect(server['activeLongPolls']).toBe(1)

        await dispatch('overflow', 'terminal.wait')
        expect(replies.map((reply) => JSON.parse(reply))).toContainEqual(
          expect.objectContaining({
            id: 'overflow',
            ok: false,
            error: expect.objectContaining({ code: 'runtime_busy' })
          })
        )
        mutation.resolve()
        await acting
        expect(replies.map((reply) => JSON.parse(reply))).toContainEqual({ id: 'action', ok: true })
        expect(server['activeLongPolls']).toBe(1)
        observer.resolve()
        await waiting
        expect(server['activeLongPolls']).toBe(0)
      } finally {
        mutation.resolve()
        observer.resolve()
        await server.stop()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )
})

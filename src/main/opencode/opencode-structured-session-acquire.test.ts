import { describe, expect, it, vi } from 'vitest'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionExitUnprovenError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { OpenCodeServerConnection } from './serve/server-connection'
import { openCodeManagedProcessFixture } from './serve/server-process-test-fixture'
import { OpenCodeStructuredSessionAdapter } from './opencode-structured-session-adapter'
import type { OpenCodeStructuredLaunch } from './opencode-structured-session-state'

const LAUNCH: OpenCodeStructuredLaunch = {
  command: 'opencode',
  cwd: '/workspace',
  environment: {},
  resumeSessionId: null,
  permissions: [],
  agent: 'opencode'
}

describe('OpenCode structured acquisition', () => {
  it.each([1, 2] as const)(
    'persists the owned process before HTTP and stops the same server in dialect %s',
    async (major) => {
      const order: string[] = []
      const managed = openCodeManagedProcessFixture()
      managed.close.mockImplementation(async () => {
        managed.exit()
        return { root: 'exited', tree: 'exited' }
      })
      const fetchImpl: typeof fetch = async (url) => {
        order.push('http')
        const path = new URL(String(url)).pathname
        if (path === '/api/info') {
          return major === 2
            ? Response.json({ version: '2.0.14', pid: 9999999 })
            : new Response('<html/>')
        }
        if (path === '/global/health') {
          return Response.json({ version: '1.18.31', healthy: true })
        }
        if (path === '/event' || path === '/api/event') {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({
                      type: 'server.connected',
                      ...(major === 1 ? { properties: {} } : { data: {} })
                    })}\n\n`
                  )
                )
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
        if (path === '/config/providers') {
          return Response.json({ providers: [] })
        }
        if (path === '/api/model' || path === '/api/agent' || path === '/api/command') {
          return Response.json({ data: [] })
        }
        if (path === '/agent' || path === '/command') {
          return Response.json([])
        }
        return Response.json(major === 1 ? { id: 'root' } : { data: { id: 'root' } })
      }
      const open = vi.fn(
        async () => new OpenCodeServerConnection(managed.process, 48718, 'fixture', fetchImpl)
      )
      const adapter = new OpenCodeStructuredSessionAdapter({
        resolveLaunch: async () => ({ ...LAUNCH, agent: major === 1 ? 'opencode' : 'opencode2' }),
        openServer: open,
        readProcessStartTime: async () => 1000
      })
      const acquisition = await adapter.acquire({
        identity: {
          sessionId: 'chat',
          workspaceId: 'workspace',
          hostId: 'local',
          agent: major === 1 ? 'opencode' : 'opencode2',
          providerHandle: null
        },
        fence: 2,
        spawnToken: 'fixture-token',
        onSpawned: async (identity) => {
          expect(identity.pid).toBe(9999999)
          order.push('persist')
        }
      })
      expect(order[0]).toBe('persist')
      expect(acquisition.link.handle.nativeId).toBe('root')
      expect(acquisition.process.spawnToken).toBe('fixture-token')
      expect(await adapter.closeSession('chat')).toBe(true)
      expect(managed.close).toHaveBeenCalledOnce()
      expect(open).toHaveBeenCalledOnce()
    }
  )

  it('keeps failed startup owned until process close is proven', async () => {
    const managed = openCodeManagedProcessFixture()
    const open = vi.fn(
      async () =>
        new OpenCodeServerConnection(
          managed.process,
          48718,
          'fixture',
          async () => new Response('<html/>')
        )
    )
    const adapter = new OpenCodeStructuredSessionAdapter({
      resolveLaunch: async () => LAUNCH,
      openServer: open,
      readProcessStartTime: async () => 1000
    })
    const input = {
      identity: {
        sessionId: 'chat',
        workspaceId: 'workspace',
        hostId: 'local',
        agent: 'opencode' as const,
        providerHandle: null
      },
      fence: 2,
      spawnToken: 'fixture-token'
    }
    await expect(adapter.acquire(input)).rejects.toBeInstanceOf(
      AgentSessionAcquisitionExitUnprovenError
    )
    await expect(adapter.acquire(input)).rejects.toBeInstanceOf(
      AgentSessionAcquisitionExitUnprovenError
    )
    expect(open).toHaveBeenCalledOnce()
    managed.close.mockImplementation(async () => {
      managed.exit()
      return { root: 'exited', tree: 'exited' }
    })
    expect(await adapter.closeSession('chat')).toBe(true)
  })

  it('does not spawn after a close overtakes launch resolution', async () => {
    let resolveLaunch = (_launch: OpenCodeStructuredLaunch): void => {}
    const launch = new Promise<OpenCodeStructuredLaunch>((resolve) => {
      resolveLaunch = resolve
    })
    let spawned = 0
    const adapter = new OpenCodeStructuredSessionAdapter({
      resolveLaunch: () => launch,
      openServer: async () => {
        spawned += 1
        throw new Error('unexpected spawn')
      }
    })
    const acquiring = adapter.acquire({
      identity: {
        sessionId: 'chat',
        workspaceId: 'workspace',
        hostId: 'host',
        agent: 'opencode',
        providerHandle: null
      },
      fence: 2,
      spawnToken: 'spawn-token'
    })
    const closing = adapter.closeSession('chat')
    resolveLaunch(LAUNCH)
    await expect(acquiring).rejects.toBeInstanceOf(AgentSessionPreSpawnError)
    await expect(closing).resolves.toBe(true)
    expect(spawned).toBe(0)
  })
})

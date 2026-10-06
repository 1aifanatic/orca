import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import { openCodeManagedProcessFixture as managedChild } from './server-process-test-fixture'
import { OpenCodeServerConnection, openOpenCodeServer } from './server-connection'

afterEach(() => vi.useRealTimers())

describe('chat-owned OpenCode server connection', () => {
  it('spawns through the shared provider owner and returns before probing for a durable identity', async () => {
    const fixture = managedChild()
    const spawn = vi.fn<typeof spawnManagedProviderProcess>(() => fixture.process)
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ version: '2.0.18', pid: 123 })
    )
    const connection = await openOpenCodeServer(
      {
        command: 'fixture-opencode',
        cwd: 'folder-workspace',
        environment: { XDG_DATA_HOME: 'pinned-account' }
      },
      {
        allocatePort: async () => 48271,
        mintPassword: () => 'fixture-password',
        spawn,
        fetch: fetchImpl
      }
    )
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(connection.process.child.pid).toBe(fixture.child.pid)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['serve', '--hostname=127.0.0.1', '--port=48271'],
        cwd: 'folder-workspace'
      }),
      {
        site: 'opencode-server-teardown',
        inheritedEnv: { XDG_DATA_HOME: 'pinned-account' }
      }
    )
    expect(fixture.child.stdout.readableFlowing).toBe(true)
    await expect(connection.waitUntilReady()).resolves.toEqual({ major: 2, version: '2.0.18' })
    await connection.close()
  })

  it('bounds startup, owns the failed child until close, and preserves unconfirmed exit proof', async () => {
    vi.useFakeTimers()
    const fixture = managedChild()
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('not yet listening')
    })
    const connection = new OpenCodeServerConnection(fixture.process, 48271, 'fixture', fetchImpl)
    const ready = expect(connection.waitUntilReady(250)).rejects.toThrow('startup did not complete')
    await vi.advanceTimersByTimeAsync(250)
    await ready
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fixture.close).not.toHaveBeenCalled()
    await expect(connection.close()).resolves.toEqual({ root: 'unverifiable', tree: null })
    expect(fixture.process.rootVerdict).toBe('live')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries connection refusal during startup but stops probing once ready', async () => {
    const fixture = managedChild()
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ version: '2.0.18', pid: 123 })
    )
    fetchImpl.mockRejectedValueOnce(new Error('not yet listening'))
    const connection = new OpenCodeServerConnection(fixture.process, 48271, 'fixture', fetchImpl)
    await expect(connection.waitUntilReady()).resolves.toEqual({ major: 2, version: '2.0.18' })
    await expect(connection.waitUntilReady()).resolves.toEqual({ major: 2, version: '2.0.18' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    await connection.close()
  })

  it('fails startup and pending HTTP on observed process exit without respawning', async () => {
    const fixture = managedChild()
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}))
    const connection = new OpenCodeServerConnection(fixture.process, 48271, 'fixture', fetchImpl)
    const ready = expect(connection.waitUntilReady()).rejects.toThrow()
    fixture.exit()
    await ready
    await expect(connection.peer.request('/session')).rejects.toMatchObject({ kind: 'closed' })
    expect(fixture.process.rootVerdict).toBe('exited')
    expect(fetchImpl).toHaveBeenCalledOnce()
    await connection.close()
  })

  it('does not restart on a permanent password refusal and treats stdout loss as transport loss', async () => {
    const fixture = managedChild()
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }))
    const connection = new OpenCodeServerConnection(fixture.process, 48271, 'fixture', fetchImpl)
    await expect(connection.waitUntilReady()).rejects.toMatchObject({ kind: 'status', status: 401 })
    expect(fetchImpl).toHaveBeenCalledOnce()
    fixture.child.stdout.emit('error', new Error('pipe unavailable'))
    expect(fixture.process.rootVerdict).toBe('live')
    await expect(connection.peer.request('/session')).rejects.toMatchObject({ kind: 'closed' })
    fixture.child.stdin.emit('error', new Error('pipe unavailable'))
    await connection.close()
  })
})

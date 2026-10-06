import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../../provider-process/managed-provider-process'
import type { ProviderProcessCloseResult } from '../../provider-process/provider-process-close'
import { openCodeServerLaunch, type OpenCodeServerLaunchInput } from './server-launch'
import { OpenCodeHttpPeer } from './http-peer'
import { OpenCodeHttpError } from './http-response'
import { awaitOpenCodeHttp, openCodeHttpDeadline } from './http-lifetime'
import { probeOpenCodeServer, type OpenCodeServerVersion } from './server-probe'

export async function allocateOpenCodeServerPort(): Promise<number> {
  const socket = createServer()
  const deadline = openCodeHttpDeadline(5_000)
  try {
    await awaitOpenCodeHttp(
      new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.listen(0, '127.0.0.1', resolve)
      }),
      deadline.signal
    )
    const address = socket.address()
    if (!address || typeof address === 'string') {
      throw new Error('OpenCode port allocation failed')
    }
    return address.port
  } finally {
    deadline.dispose()
    socket.close()
  }
}

export type OpenCodeServerConnectionDeps = {
  allocatePort?: () => Promise<number>
  mintPassword?: () => string
  spawn?: typeof spawnManagedProviderProcess
  fetch?: typeof fetch
}

/** The chat owns this server from spawn through proven close, including failed startup. */
export class OpenCodeServerConnection {
  readonly peer: OpenCodeHttpPeer
  private readonly cancellation = new AbortController()
  private ready?: Promise<OpenCodeServerVersion>

  constructor(
    readonly process: ManagedProviderProcess,
    port: number,
    password: string,
    fetchImpl?: typeof fetch
  ) {
    this.peer = new OpenCodeHttpPeer({ port, password, fetch: fetchImpl })
    // The managed child drains stderr; stdout has no protocol frames and must also keep flowing.
    process.child.stdout.resume()
    process.child.stdin.on('error', () => {})
    process.child.stdout.on('error', () => this.peer.close())
    process.onExit(() => {
      this.cancellation.abort()
      this.peer.close()
    })
  }

  waitUntilReady(timeoutMs = 30_000): Promise<OpenCodeServerVersion> {
    this.ready ??= this.probeUntilReady(timeoutMs)
    return this.ready
  }

  close(): Promise<ProviderProcessCloseResult> {
    this.cancellation.abort()
    this.peer.close()
    return this.process.close()
  }

  private async probeUntilReady(timeoutMs: number): Promise<OpenCodeServerVersion> {
    const deadline = openCodeHttpDeadline(timeoutMs)
    const signal = AbortSignal.any([this.cancellation.signal, deadline.signal])
    try {
      for (;;) {
        signal.throwIfAborted()
        try {
          return await probeOpenCodeServer(this.peer, signal)
        } catch (error) {
          if (!(error instanceof OpenCodeHttpError) || error.kind !== 'transport') {
            throw error
          }
        }
        await delay(100, undefined, { signal })
      }
    } catch (error) {
      if (error instanceof OpenCodeHttpError) {
        throw error
      }
      throw new OpenCodeHttpError('transport', 'OpenCode server startup did not complete')
    } finally {
      deadline.dispose()
    }
  }
}

/** Returns before the handshake so the caller can persist the spawned process identity first. */
export async function openOpenCodeServer(
  input: Omit<OpenCodeServerLaunchInput, 'port' | 'password'>,
  deps: OpenCodeServerConnectionDeps = {}
): Promise<OpenCodeServerConnection> {
  const port = await (deps.allocatePort ?? allocateOpenCodeServerPort)()
  const password = (deps.mintPassword ?? (() => randomBytes(32).toString('base64url')))()
  const launch = openCodeServerLaunch({ ...input, port, password })
  const process = (deps.spawn ?? spawnManagedProviderProcess)(launch, {
    site: 'opencode-server-teardown',
    inheritedEnv: input.environment
  })
  return new OpenCodeServerConnection(process, port, password, deps.fetch)
}
